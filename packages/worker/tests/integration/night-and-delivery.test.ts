import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteUnclaimedAttachments } from "../../src/attachment-sweep";
import { runScheduledBackups } from "../../src/backup-run";
import { destroyMailboxCompletely } from "../../src/mailbox-destroy";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	sessionToken,
	testAuthBeforeAll,
	userId,
} from "./utils";

/**
 * Things that ran after the fact -- a notification, the nightly backup, a
 * sweep, a purge -- and turned a small failure into a larger one.
 */

// @ts-expect-error test binding
const bucket = (): R2Bucket => env.BUCKET;
// @ts-expect-error test binding
const box = (id: string) => env.MAILBOX.get(env.MAILBOX.idFromName(id));
// @ts-expect-error test binding
const auth = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

/** An env whose bucket answers `method` with `replacement`. */
function withBucket(
	method: string,
	replacement: (target: R2Bucket) => unknown,
): typeof env {
	const watched = new Proxy(bucket(), {
		get(target, property) {
			if (property === method) return replacement(target);
			const member = Reflect.get(target, property);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
	return { ...(env as object), BUCKET: watched } as typeof env;
}

async function settings(id: string) {
	return (
		(await (await bucket().get(`mailboxes/${id}.json`))?.json<any>()) ?? {}
	);
}

async function receive(raw: string, e: object = env) {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(raw);
	const rejections: string[] = [];
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(c) {
					c.enqueue(bytes);
					c.close();
				},
			}),
			rawSize: bytes.length,
			to: mailboxId,
			setReject: (reason: string) => rejections.push(reason),
		},
		e,
		createExecutionContext(),
	);
	return rejections;
}

describe("a new message whose notification fails", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * The message is stored before the notification is tried. Anything the
	 * notification threw used to fail the delivery of mail already stored.
	 */
	it("is delivered all the same", async () => {
		await runInDurableObject(auth(), async (_i, state) => {
			state.storage.sql.exec(
				"INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, created_at) VALUES ('p', ?, ?, 'https://push.example.net/x', 'k', 'a', 0)",
				userId,
				sessionToken,
			);
		});
		const broken = { ...(env as object), VAPID_PRIVATE_KEY: "not json" };

		await expect(
			receive(
				`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: arrives\r\n\r\nbody`,
				broken,
			),
		).resolves.toEqual([]);
		expect(await box(mailboxId).listAllEmailIds()).toHaveLength(1);
	});
});

describe("a nightly backup that fails", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * `lastRunAt` decides when the next one is due. Moved on a failure, one
	 * transient error put a weekly backup off for a week.
	 */
	it("leaves the mailbox due, and says it failed", async () => {
		const earlier = "2026-09-01T18:00:00.000Z";
		const stored = await settings(mailboxId);
		await bucket().put(
			`mailboxes/${mailboxId}.json`,
			JSON.stringify({
				...stored,
				autoBackup: {
					enabled: true,
					frequency: "weekly",
					keep: 3,
					lastRunAt: earlier,
				},
			}),
		);

		const failing = withBucket("createMultipartUpload", () => async () => {
			throw new Error("R2 is having a moment");
		});
		const now = new Date("2026-09-09T18:00:00.000Z");
		const summary = await runScheduledBackups(failing as never, now);

		expect(summary.failed).toBe(1);
		const after = (await settings(mailboxId)).autoBackup;
		expect(after.lastRunAt).toBe(earlier);
		expect(after.lastResult).toMatchObject({ ok: false });

		// And the next night tries again rather than waiting out the week.
		const retry = await runScheduledBackups(
			env as never,
			new Date("2026-09-10T18:00:00.000Z"),
		);
		expect(retry.ran).toBe(1);
		expect((await settings(mailboxId)).autoBackup.lastRunAt).toBe(
			"2026-09-10T18:00:00.000Z",
		);
	});
});

describe("destroying a mailbox", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * The message ids are the only record of which objects were the
	 * mailbox's. Failing to read them used to be swallowed, and the rest of
	 * the destruction went ahead without them.
	 */
	it("stops if it cannot learn what the mailbox holds", async () => {
		// @ts-expect-error test binding
		const ns = env.MAILBOX;
		const unreadable = new Proxy(ns, {
			get(target, property) {
				if (property !== "get") {
					const member = Reflect.get(target, property);
					return typeof member === "function" ? member.bind(target) : member;
				}
				return (id: DurableObjectId) =>
					new Proxy(target.get(id), {
						get(stub, p) {
							if (p === "listAllEmailIds") {
								return async () => {
									throw new Error("storage unavailable");
								};
							}
							return Reflect.get(stub, p);
						},
					});
			},
		});

		await expect(
			destroyMailboxCompletely(
				{ ...(env as object), MAILBOX: unreadable } as never,
				mailboxId,
			),
		).rejects.toThrow("storage unavailable");
		expect(await bucket().head(`mailboxes/${mailboxId}.json`)).not.toBeNull();
	});
});

describe("deleting unclaimed attachments", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * Ingest writes the object before the row that names it, so an object
	 * uploaded while the sweep runs looks unclaimed. It is left for later.
	 */
	it("leaves an object uploaded after the rows were read", async () => {
		await bucket().put("attachments/arriving/att/f.txt", "in flight");
		const later = withBucket(
			"list",
			(target) => async (options: R2ListOptions) => {
				const listed = await target.list(options);
				return {
					...listed,
					objects: listed.objects.map((object) => ({
						...object,
						key: object.key,
						size: object.size,
						uploaded: new Date(Date.now() + 60_000),
					})),
				};
			},
		);

		const result = await deleteUnclaimedAttachments(later as never);
		expect(result).toMatchObject({ deleted: 0, remaining: 1 });
		expect(
			await bucket().head("attachments/arriving/att/f.txt"),
		).not.toBeNull();

		expect(await deleteUnclaimedAttachments(env as never)).toMatchObject({
			deleted: 1,
		});
	});
});

describe("a restored message's date", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * Stored as sent, `Tue, 3 Sep 2024 ...` sorted above every ISO date and
	 * stayed at the top of the folder for good.
	 */
	it("is stored the way received mail's is, and sorts with it", async () => {
		for (const [subject, date] of [
			["newer", "2026-09-01T00:00:00.000Z"],
			["older", "Tue, 03 Sep 2024 10:00:00 +0900"],
		]) {
			const res = await authenticatedFetch(
				`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						folder: "inbox",
						date,
						rawEmailBase64: btoa(
							`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: ${subject}\r\n\r\nx`,
						),
					}),
				},
			);
			expect(res.status).toBe(201);
		}

		const listed = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
			)
		).json<{ subject: string; date: string }[]>();
		expect(listed.map((e) => [e.subject, e.date])).toEqual([
			["newer", "2026-09-01T00:00:00.000Z"],
			["older", "2024-09-03T01:00:00.000Z"],
		]);
	});
});

describe("the push public key", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	const ask = async (e: object) => {
		const worker = await import("../../dev/index");
		const res = await worker.default.fetch(
			new Request("http://local.test/api/v1/push/vapid-public-key", {
				headers: { Authorization: `Bearer ${sessionToken}` },
			}),
			e,
			createExecutionContext(),
		);
		return (await res.json<{ publicKey: string }>()).publicKey;
	};

	/**
	 * Without the private half nothing can be delivered, and a fork inherits
	 * this repository's public key; the switch must not look usable.
	 */
	it("is withheld when there is no private key to send with", async () => {
		expect(await ask(env)).not.toBe("");
		expect(await ask({ ...(env as object), VAPID_PRIVATE_KEY: "" })).toBe("");
	});
});
