import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * What actually leaves for Resend when a message carries an attachment.
 *
 * attachment-bytes.test.ts holds the other half: that the copy filed in Sent
 * is byte-for-byte what was uploaded. The two are different questions with
 * different answers available, and only one of them was being asked. The
 * stored copy is written by decoding the base64 ourselves; the outgoing copy
 * is the base64 string handed to Resend untouched. A change to either one
 * leaves the other passing -- so "the sender's own copy is fine" says nothing
 * about what the recipient got, which is the half that matters to them.
 *
 * The subject marker makes the Resend stub echo the request back through the
 * error path, which is the only way a caller ever sees what was sent.
 *
 * One link is beyond this file and beyond this repository: what Resend does
 * with the base64 after it accepts it. Nothing here can reach that, and no
 * test should pretend to -- it is proven by sending one real message and
 * opening the attachment at the other end.
 */

const ECHO = "ECHO_RESEND_REQUEST";

/**
 * A byte in every class that a text round trip would damage: a PNG signature,
 * a lone high byte, a NUL, and 0xFF -- none of which is valid UTF-8 on its
 * own. ASCII is the one input on which the damage is invisible.
 */
const BINARY = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x93,
	0xfa, 0x7f, 0x41,
]);

const toBase64 = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

const fromBase64 = (text: string) =>
	Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

const send = (body: Record<string, unknown>) =>
	authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}/emails`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: mailboxId, ...body }),
	});

/** The request the Worker made to Resend, read back out of the error body. */
async function outbound(attachment: Record<string, unknown>) {
	const res = await send({
		to: "recipient@example.org",
		subject: `${ECHO} attachment`,
		text: "body",
		attachments: [attachment],
	});
	const { error } = await res.json<{ error: string }>();
	const payload = error.slice(error.indexOf("{"));
	return JSON.parse(payload) as {
		attachments?: Array<{
			filename: string;
			content: string;
			content_type: string;
		}>;
	};
}

describe("the attachment that leaves for Resend", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("carries the uploaded bytes, unchanged", async () => {
		const sent = await outbound({
			filename: "photo.png",
			content: toBase64(BINARY),
			type: "image/png",
			disposition: "attachment",
		});

		expect(sent.attachments).toHaveLength(1);
		expect(Array.from(fromBase64(sent.attachments?.[0].content ?? ""))).toEqual(
			Array.from(BINARY),
		);
	});

	// The name and the type travel with it: a PDF announced as
	// application/octet-stream is a file the recipient's client will not open.
	it("carries the filename and the content type", async () => {
		const sent = await outbound({
			filename: "請求書.pdf",
			content: toBase64(BINARY),
			type: "application/pdf",
			disposition: "attachment",
		});

		expect(sent.attachments?.[0].filename).toBe("請求書.pdf");
		expect(sent.attachments?.[0].content_type).toBe("application/pdf");
	});

	it("sends nothing in the attachments field when there are none", async () => {
		const res = await send({
			to: "recipient@example.org",
			subject: `${ECHO} plain`,
			text: "body",
		});
		const { error } = await res.json<{ error: string }>();
		const sent = JSON.parse(error.slice(error.indexOf("{"))) as {
			attachments?: unknown;
		};
		expect(sent.attachments).toBeUndefined();
	});
});
