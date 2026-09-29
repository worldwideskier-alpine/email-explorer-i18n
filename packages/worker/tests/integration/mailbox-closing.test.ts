import { createExecutionContext, env } from "cloudflare:test";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it } from "vitest";
import { MAILBOX_CLOSED } from "../../src/durableObject";
import { ingestEmailIntoMailbox } from "../../src/email-ingest";
import {
	destroyMailboxCompletely,
	finishUnfinishedDeletions,
	holdsMailOrArchives,
	rememberUnfinishedDeletion,
	UNFINISHED_DELETIONS_KEY,
} from "../../src/mailbox-destroy";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Mail on its way in while its mailbox is destroyed.
 *
 * Delivery asks whether the settings object exists and writes the message
 * afterwards -- seconds afterwards when the spam check runs in between. A
 * deletion in that gap wiped the mailbox and the message landed in it after:
 * mail that nobody held, which is what makes an address impossible for
 * anyone to create again, and bucket objects nothing named.
 */

const RAW = [
	"From: sender@example.net",
	`To: ${mailboxId}`,
	"Subject: late",
	"MIME-Version: 1.0",
	'Content-Type: multipart/mixed; boundary="b"',
	"",
	"--b",
	"Content-Type: text/plain",
	"",
	"late",
	"--b",
	"Content-Type: text/plain",
	'Content-Disposition: attachment; filename="a.txt"',
	"",
	"attached",
	"--b--",
	"",
].join("\r\n");

const box = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
const objects = async () =>
	[
		...(await env.BUCKET.list({ prefix: "raw/" })).objects,
		...(await env.BUCKET.list({ prefix: "attachments/" })).objects,
	].map((o) => o.key);

/** A delivery that passed the settings check before the deletion began. */
async function lateDelivery() {
	const bytes = new TextEncoder().encode(RAW);
	return ingestEmailIntoMailbox(
		env as never,
		mailboxId,
		"inbox",
		await new PostalMime().parse(bytes),
		{ rawEmail: bytes },
	);
}

async function receive() {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(RAW);
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
		env,
		createExecutionContext(),
	);
	return rejections;
}

describe("a message arriving after its mailbox was destroyed", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is refused, and leaves nothing behind", async () => {
		await destroyMailboxCompletely(env as never, mailboxId);

		await expect(lateDelivery()).rejects.toThrow(MAILBOX_CLOSED);
		expect(await box().listAllEmailIds()).toEqual([]);
		expect(await objects()).toEqual([]);
		expect(await holdsMailOrArchives(env as never, mailboxId)).toBe(false);
	});

	it("is refused when it lands after the deletion read the mailbox", async () => {
		// Delivered between the read of which messages there are and the
		// wipe: the wipe took its row, and its bucket objects -- not on the
		// list read before it -- stayed with nothing naming them.
		const delivered: unknown[] = [];
		const ns = env.MAILBOX;
		const racing = new Proxy(ns, {
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
									const ids = await stub.listAllEmailIds();
									delivered.push(
										await lateDelivery().catch((e: Error) => e.message),
									);
									return ids;
								};
							}
							return Reflect.get(stub, p);
						},
					});
			},
		});
		await destroyMailboxCompletely(
			{ ...env, MAILBOX: racing } as never,
			mailboxId,
		);

		expect(delivered).toEqual([MAILBOX_CLOSED]);
		expect(await objects()).toEqual([]);
	});

	it("is refused the way mail for no mailbox is", async () => {
		// The settings were there when delivery asked; the object had closed.
		await box().closeMailbox();
		expect(await receive()).toEqual([`No mailbox exists for ${mailboxId}`]);
		expect(await box().listAllEmailIds()).toEqual([]);
		expect(await objects()).toEqual([]);
	});

	it("does not stop the address being created again, which takes mail", async () => {
		await destroyMailboxCompletely(env as never, mailboxId);
		await createDummyMailbox();
		expect(await receive()).toEqual([]);
		expect(await box().listAllEmailIds()).toHaveLength(1);
	});

	it("is refused during a purge too, and the recreated mailbox takes mail", async () => {
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings: { deletionLocked: false } }),
			},
		);
		const purged = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}?purge=true`,
			{ method: "DELETE" },
		);
		expect(purged.status).toBe(204);
		await expect(lateDelivery()).rejects.toThrow(MAILBOX_CLOSED);

		await createDummyMailbox();
		expect(await receive()).toEqual([]);
	});
});

/**
 * A deletion the nightly run is finishing, of an address somebody has since
 * created again. The run destroyed the new mailbox, their mail with it.
 */
describe("an unfinished deletion of an address created again since", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	it("leaves the new mailbox alone, and comes off the list", async () => {
		await rememberUnfinishedDeletion(env as never, mailboxId);
		await createDummyMailbox();
		expect(await receive()).toEqual([]);

		expect(await finishUnfinishedDeletions(env as never)).toEqual({
			finished: 1,
			left: 0,
		});
		expect(await box().listAllEmailIds()).toHaveLength(1);
		expect(await env.BUCKET.head(`mailboxes/${mailboxId}.json`)).not.toBeNull();
		expect(
			await (await env.BUCKET.get(UNFINISHED_DELETIONS_KEY))?.json(),
		).toEqual([]);
	});
});
