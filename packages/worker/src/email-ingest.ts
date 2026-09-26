import type PostalMime from "postal-mime";
import { charsetsForAttachments, typeWithCharset } from "./attachment-charset";
import { storableFilename } from "./attachment-name";
import { plainTextToHtml } from "./plain-text-to-html";
import { notifyNewEmail } from "./push-notify";
import { formatAddressList } from "./recipients";
import type { Env } from "./types";

/**
 * Shared by the real Cloudflare Email Routing trigger (receiveEmail in
 * index.ts) and the admin IMAP-import endpoint (PostImportEmail in
 * routes/import.ts): stores a postal-mime-parsed message into a mailbox's
 * Durable Object, handling attachment upload to R2 and threading-header
 * normalization identically for both paths.
 */
export async function ingestEmailIntoMailbox(
	env: Env,
	mailboxId: string,
	folder: string,
	parsedEmail: Awaited<ReturnType<PostalMime["parse"]>>,
	overrides: {
		date?: string;
		read?: boolean;
		starred?: boolean;
		notify?: boolean;
		rawEmail?: ArrayBuffer | Uint8Array;
		/**
		 * Only the restore path passes this, so a message keeps the id its
		 * backup recorded and restoring the same file twice is a no-op rather
		 * than a second copy of every message. The caller has already checked
		 * the id is free here; inbound mail never has one to reuse.
		 */
		id?: string;
	} = {},
) {
	const messageId = overrides.id ?? crypto.randomUUID();

	// Nothing here creates the mailbox. Both callers check it exists first --
	// receiveEmail rejects mail for an address with no mailbox, the import
	// route answers 404 -- because creating it here brought deleted mailboxes
	// back with empty settings.

	// Kept as bytes rather than decoded: the part headers this is read for are
	// ASCII, but the body around them is whatever the sender sent.
	const raw = overrides.rawEmail
		? overrides.rawEmail instanceof Uint8Array
			? overrides.rawEmail
			: new Uint8Array(overrides.rawEmail)
		: null;

	if (raw) {
		await env.BUCKET.put(`raw/${messageId}.eml`, raw);
	}

	const ns = env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	const attachmentData = [];
	if (parsedEmail.attachments) {
		// What the parser dropped. postal-mime gives a bare `text/plain` with
		// the parameters gone, so a Shift_JIS attachment became indistinguishable
		// from a UTF-8 one the moment the row was written -- and every reader
		// afterwards rebuilds the type from that row. The message itself still
		// says, so it is read back out of the copy being stored a few lines
		// above. See attachment-charset.ts.
		const charsets = raw
			? charsetsForAttachments(raw, parsedEmail.attachments)
			: [];

		for (const [index, att] of parsedEmail.attachments.entries()) {
			const attachmentId = crypto.randomUUID();
			// One name for the key and the row. They were `att.filename` and
			// `att.filename || "untitled"`, so an attachment that arrived
			// without a name was stored under ".../undefined" and looked for
			// under ".../untitled" -- present in the bucket and unreadable by
			// everything that goes through the row, the archive included.
			const filename = storableFilename(att.filename);
			const attKey = `attachments/${messageId}/${attachmentId}/${filename}`;
			await env.BUCKET.put(attKey, att.content);
			attachmentData.push({
				id: attachmentId,
				email_id: messageId,
				filename,
				mimetype: typeWithCharset(
					att.mimeType,
					charsets[index] ?? null,
					att.content as Uint8Array | string | null,
				),
				size:
					typeof att.content === "string"
						? att.content.length
						: att.content.byteLength,
				content_id: att.contentId || null,
				disposition: att.disposition,
			});
		}
	}

	// Strip angle brackets from message IDs since postal-mime returns raw RFC 2822
	// values (e.g. "<msg@example.com>") but we store bare IDs to match outgoing emails
	const stripBrackets = (s: string) => s.replace(/^</, "").replace(/>$/, "");
	const inReplyTo = parsedEmail.inReplyTo
		? stripBrackets(parsedEmail.inReplyTo)
		: null;
	const emailReferences = parsedEmail.references
		? parsedEmail.references.split(/\s+/).filter(Boolean).map(stripBrackets)
		: [];

	await stub.createEmail(
		folder,
		{
			id: messageId,
			subject: parsedEmail.subject || "",
			sender: parsedEmail.from?.address || "",
			// The whole To: and Cc: lists, not just the first address, so
			// "reply all" can reach everyone who saw the message. This does not
			// decide which mailbox the message lands in -- that is the envelope
			// recipient, settled before this is called -- it is only what gets
			// shown and replied to.
			recipient: formatAddressList(addressesOf(parsedEmail.to)) || mailboxId,
			cc: formatAddressList(addressesOf(parsedEmail.cc)),
			date: storedDate(overrides.date),
			body:
				parsedEmail.html ||
				(parsedEmail.text ? plainTextToHtml(parsedEmail.text) : ""),
			in_reply_to: inReplyTo,
			email_references:
				emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: emailReferences[0] || inReplyTo || messageId,
			// What a reply names as its parent. The row id is ours and means
			// nothing to the sender's client.
			message_id: parsedEmail.messageId
				? stripBrackets(parsedEmail.messageId.trim())
				: null,
		},
		attachmentData,
	);

	if (overrides.read || overrides.starred) {
		await stub.updateEmail(messageId, {
			read: overrides.read,
			starred: overrides.starred,
		});
	}

	if (overrides.notify && folder !== "spam") {
		const announced = await notifyNewEmail(env, mailboxId, {
			id: messageId,
			sender: parsedEmail.from?.address || "",
			subject: parsedEmail.subject || "",
		});
		// Only an announced message is worth dismissing later.
		if (announced) await stub.markNotified(messageId).catch(() => {});
	}

	return messageId;
}

/**
 * Every address in a To: or Cc: list, the members of a group included.
 *
 * `Team: a@x, b@x;` is one entry to the parser, with the members under
 * `group` and no address of its own, so reading `address` alone dropped
 * everyone in it -- and "reply all" with them.
 */
export function addressesOf(
	list:
		| readonly {
				address?: string;
				group?: readonly { address?: string }[];
		  }[]
		| undefined,
): string[] {
	return (list ?? []).flatMap((entry) =>
		entry.group
			? entry.group.map((member) => member.address ?? "")
			: [entry.address ?? ""],
	);
}

/**
 * The date column as ISO UTC, which is what received mail already has.
 *
 * A restore passes the imported message's own date, and that was stored as
 * sent: `Tue, 3 Sep 2024 ...` sorts above every ISO date, because the column
 * is compared as text ('T' > '2') -- so the message sat at the top of its
 * folder for good, fell outside every date-bounded search, and went into the
 * archive out of order. A date that cannot be read is kept as it came rather
 * than replaced with today's.
 */
export function storedDate(given: string | undefined): string {
	if (!given) return new Date().toISOString();
	const at = Date.parse(given);
	return Number.isFinite(at) ? new Date(at).toISOString() : given;
}
