import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * An attachment must come back out of storage as the bytes that went in.
 *
 * The copy kept in Sent is not decoration: it is what the download link
 * serves, what the mbox export writes, and what a backup restores. A file
 * that arrives at the recipient intact but is corrupt in our own copy is a
 * silent data loss -- the sender has no reason to look, and by the time
 * anyone does the original is gone.
 *
 * The existing attachment tests all use `test.txt`, whose every byte is
 * ASCII. That is why this went unnoticed: ASCII is the one input on which a
 * UTF-8 round trip is the identity function. Anything real -- a PDF, a
 * photograph, a spreadsheet -- has bytes above 0x7F, and those are where the
 * damage happens.
 */

/** A byte in every class, including the ones UTF-8 encoding would expand. */
const BINARY = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // a PNG signature
	0x00, 0x01, 0x7f, 0x80, 0x81, 0xc0, 0xfe, 0xff, // the boundary bytes
	0xe3, 0x81, 0x82, // one valid UTF-8 sequence, which must not be "fixed"
]);

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

const send = (attachments: unknown[]) =>
	authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}/emails`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			from: mailboxId,
			to: "someone@example.org",
			subject: "with a real file",
			text: "see attached",
			attachments,
		}),
	});

const attachment = (bytes: Uint8Array, filename = "picture.png") => ({
	content: toBase64(bytes),
	filename,
	type: "image/png",
	disposition: "attachment",
});

async function sentEmail(): Promise<{
	id: string;
	attachments: { id: string; filename: string; size: number }[];
}> {
	const list = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=sent`,
	);
	const emails = await list.json<{ id: string }[]>();
	expect(emails.length).toBeGreaterThan(0);

	const detail = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emails[0].id}`,
	);
	return await detail.json();
}

describe("attachment bytes", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("serves back exactly the bytes that were sent", async () => {
		expect((await send([attachment(BINARY)])).status).toBe(201);

		const email = await sentEmail();
		expect(email.attachments).toHaveLength(1);

		const download = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${email.id}/attachments/${email.attachments[0].id}`,
		);
		expect(download.status).toBe(200);

		const served = new Uint8Array(await download.arrayBuffer());
		expect(Array.from(served)).toEqual(Array.from(BINARY));
	});

	// This one was already right and is kept as a guard: the recorded size is
	// what the UI shows, and it must stay the file's own size even though the
	// stored object briefly was not.
	it("records the file's own size", async () => {
		await send([attachment(BINARY)]);
		const email = await sentEmail();
		expect(email.attachments[0].size).toBe(BINARY.byteLength);
	});

	it("keeps a plain text attachment intact too", async () => {
		const text = new TextEncoder().encode("日本語のテキスト\n");
		await send([attachment(text, "note.txt")]);

		const email = await sentEmail();
		const download = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${email.id}/attachments/${email.attachments[0].id}`,
		);
		const served = new Uint8Array(await download.arrayBuffer());
		expect(Array.from(served)).toEqual(Array.from(text));
	});
});
