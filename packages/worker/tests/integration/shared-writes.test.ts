import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordSenderVerdict } from "../../src/mailbox-settings";
import { purgeMailboxSpam } from "../../src/spam-purge-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	personId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Things more than one party writes, or that one call reads a great deal
 * of: the settings object, the purge's deletions, a large batch of ids, a
 * mailbox two people hold.
 */

// @ts-expect-error test binding
const bucket = (): R2Bucket => env.BUCKET;
// @ts-expect-error test binding
const box = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
// @ts-expect-error test binding
const auth = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

const settings = async () =>
	(await (await bucket().get(`mailboxes/${mailboxId}.json`))?.json<any>()) ??
	{};

const save = (body: Record<string, unknown>) =>
	authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ settings: body }),
	});

describe("saving one section of a mailbox's settings", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * A save used to start from what it sent, so it had to send everything to
	 * keep everything -- and a screen saving its one section sent its stale
	 * copy of all the others.
	 */
	it("leaves the others as they are", async () => {
		expect(
			(
				await save({
					fromName: "Office",
					spamFilter: { enabled: true, claudeApiKey: "sk-ant-api03-kept" },
				})
			).status,
		).toBe(200);
		expect(
			(await save({ autoBackup: { enabled: true, frequency: "daily" } }))
				.status,
		).toBe(200);

		const stored = await settings();
		expect(stored.fromName).toBe("Office");
		// The key is carried separately from the rest of the filter; a save
		// without the filter used to keep the key and drop everything else.
		expect(stored.spamFilter).toEqual({
			enabled: true,
			claudeApiKey: "sk-ant-api03-kept",
		});
		expect(stored.signature).toMatchObject({ enabled: true });
		expect(stored.autoBackup).toMatchObject({
			enabled: true,
			frequency: "daily",
		});
	});

	/**
	 * A verdict and a save writing the one object at once: each put back the
	 * whole object it had read, so the second erased the first.
	 */
	it("keeps a spam verdict given while it was being saved", async () => {
		const racing = new Proxy(bucket(), {
			get(target, property) {
				if (property === "put") {
					let once = false;
					return async (...args: Parameters<R2Bucket["put"]>) => {
						if (!once && args[0] === `mailboxes/${mailboxId}.json`) {
							once = true;
							await recordSenderVerdict(
								{ BUCKET: target },
								mailboxId,
								"Spammer@Example.org",
								"spam",
							);
						}
						return target.put(...args);
					};
				}
				const member = Reflect.get(target, property);
				return typeof member === "function" ? member.bind(target) : member;
			},
		});
		const { rewriteJson } = await import("../../src/r2-json");
		const { mergeMailboxSettings } = await import("../../src/mailbox-settings");
		await rewriteJson<Record<string, unknown>>(
			racing,
			`mailboxes/${mailboxId}.json`,
			(existing) =>
				existing
					? mergeMailboxSettings(existing, { fromName: "Saved" })
					: undefined,
		);

		const stored = await settings();
		expect(stored.fromName).toBe("Saved");
		expect(stored.senderRules?.block).toEqual(["spammer@example.org"]);
	});
});

/** Rows straight into the mailbox: 120 old messages in spam, with originals. */
async function spamPile(count: number): Promise<string[]> {
	const ids = Array.from({ length: count }, () => crypto.randomUUID());
	await runInDurableObject(box(), async (_i, state) => {
		for (const id of ids) {
			state.storage.sql.exec(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, received_at, spam_since)
				 VALUES (?, 'spam', 's', 'a@example.org', ?, '2026-01-01T00:00:00.000Z', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
				id,
				mailboxId,
			);
		}
	});
	for (const id of ids) await bucket().put(`raw/${id}.eml`, "x");
	return ids;
}

describe("the spam purge cut off partway", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * It deleted every row first and every object after: a run killed in
	 * between -- as the backup pass was -- left the originals of every deleted
	 * row in the bucket with nothing naming them.
	 */
	it("leaves no original behind for a row it deleted", async () => {
		const ids = await spamPile(120);
		// @ts-expect-error test binding
		const ns = env.MAILBOX;
		let calls = 0;
		const cut = new Proxy(ns, {
			get(target, property) {
				if (property !== "get") {
					const member = Reflect.get(target, property);
					return typeof member === "function" ? member.bind(target) : member;
				}
				return (id: DurableObjectId) =>
					new Proxy(target.get(id), {
						get(stub, p) {
							if (p !== "deleteEmailsIn") return Reflect.get(stub, p);
							return async (...args: unknown[]) => {
								if (calls++ > 0) throw new Error("invocation ended");
								return stub.deleteEmailsIn(...args);
							};
						},
					});
			},
		});

		await expect(
			purgeMailboxSpam(
				{ ...(env as object), MAILBOX: cut } as never,
				mailboxId,
				new Date("2026-09-01T00:00:00.000Z"),
				30,
			),
		).rejects.toThrow("invocation ended");

		const left = new Set(await box().listAllEmailIds());
		expect(left.size).toBe(120 - 99);
		for (const id of ids) {
			const original = await bucket().head(`raw/${id}.eml`);
			expect(original !== null, id).toBe(left.has(id));
		}
	});
});

describe("reading more than a hundred messages at once", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/** The runtime binds at most 100 variables; one per id went over. */
	it("reads every one of them", async () => {
		const ids = await spamPile(150);
		const read = await box().getEmailsByIds(ids);
		expect(read.map((row: { id: string }) => row.id)).toEqual(ids);
	});
});

describe("deleting a person", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * A grant can name one mailbox for two people -- the legacy backfill, or
	 * two creations before the claim was atomic. Deleting either person
	 * destroyed the mailbox, and with it the other one's mail.
	 */
	it("does not take a mailbox somebody else also holds", async () => {
		await auth().giveMailboxToPerson("person-other", mailboxId);
		await auth().giveMailboxToPerson(personId, "only-mine@example.com");

		const result = await auth().deletePerson(personId);

		expect(result.status).toBe("ok");
		expect(result.mailboxIds).toEqual(["only-mine@example.com"]);
		expect(await auth().listPersonMailboxes("person-other")).toEqual([
			mailboxId,
		]);
	});
});
