/**
 * Renders a mailbox as an mbox file -- the format Thunderbird, mutt and most
 * other clients import, so a backup taken here can actually be read back
 * somewhere else.
 *
 * There is no backup otherwise: deleting a message removes it from the
 * Durable Object and its raw copy from R2, and nothing keeps a second copy.
 */

import type { Env } from "./types";

interface ExportedAttachment {
	id: string;
	filename: string;
	mimetype: string;
	/** Both are on the row; neither was ever written into the archive. */
	content_id?: string | null;
	disposition?: string | null;
}

export interface ExportedEmail {
	id: string;
	/** The emails row stores the folder under this name, not `folder`. */
	folder_id?: string;
	subject?: string;
	sender?: string;
	recipient?: string;
	date?: string;
	read?: boolean;
	starred?: boolean;
	body?: string | null;
	attachments?: ExportedAttachment[];
}

/**
 * A header value has to be ASCII, so anything else is encoded per RFC 2047.
 * The whole value goes in one encoded word: line-length limits are advisory
 * and every reader handles a long one, whereas splitting a base64 word across
 * multi-byte characters produces mojibake.
 */
function encodeHeader(value: string): string {
	/*
	 * Printable ASCII passes through -- unless it would be read as something
	 * other than itself. "=?" opens an encoded word, so a value that already
	 * contains one is decoded on the way back in and what comes out is not
	 * what went in: an attachment sent as `=?utf-8?B?ZXZpbA==?=.txt` restores
	 * as `evil.txt`, and the sender chose both. Encoding it makes the encoded
	 * word the outer one, and the inner text stays text.
	 */
	if (!/[^ -~]/.test(value) && !value.includes("=?")) return value;
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `=?UTF-8?B?${btoa(binary)}?=`;
}

/**
 * Base64, wrapped at 76 characters, a line at a time.
 *
 * It used to build the whole thing three times over before wrapping it: one
 * latin1 string as long as the attachment, `btoa` of that, the array `.match`
 * cut it into, and then the join. With the source and the encoded result on
 * top, six or seven full copies were live at the peak.
 *
 * Nobody had noticed because nothing ever reached here: the attachment read
 * above asked for a key no writer used, so it always missed and this was
 * never called with anything. Fixing that key is what made the cost real, and
 * at the 20 MiB a message may carry it is the isolate's whole budget.
 *
 * 57 bytes is 76 characters of base64 exactly, so each line can be encoded on
 * its own and no line is ever re-cut. What is held is the source and the lines,
 * not four more copies of it.
 */
const BASE64_LINE_BYTES = 57;

/**
 * A filename as a `filename="..."` parameter, quotes included.
 *
 * The name comes from the message, which means it comes from whoever sent it.
 * It was interpolated straight into the parameter: a name holding a quote --
 * postal-mime hands those back from ordinary mail -- closed the string early,
 * so `a"; name="x.txt` was archived as a part whose filename is `a`, with the
 * rest read as another parameter. A name holding a line ending ends the header
 * and writes whatever follows into the message.
 *
 * encodeHeader answers either an encoded word, which is base64 and punctuation
 * a quoted string holds as it stands, or the value unchanged when it is plain
 * ASCII -- and plain ASCII is exactly where a quote or a backslash survives to
 * be escaped here. The line endings go first, so neither route can carry one.
 */
function quotedFilename(value: string): string {
	const oneLine = value.replace(/[\r\n]+/g, " ");
	return `"${encodeHeader(oneLine).replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/**
 * A header value split on its parameters, and not on the semicolons inside
 * them.
 *
 * `split(";")` cuts inside a quoted string too, so
 * `text/plain; name="report; charset=utf-8"` produced a fragment that looked
 * exactly like a charset parameter and was believed. A sender could therefore
 * put any charset on any part -- including a wrong one over a Shift_JIS body,
 * which is the corruption this file spends its length trying to avoid.
 */
function splitParameters(value: string): string[] {
	const out: string[] = [];
	let current = "";
	let quoted = false;

	for (let at = 0; at < value.length; at++) {
		const ch = value[at];
		if (ch === "\\" && quoted) {
			// A quoted pair: the next character is data, whatever it is.
			current += ch + (value[at + 1] ?? "");
			at++;
		} else if (ch === '"') {
			quoted = !quoted;
			current += ch;
		} else if (ch === ";" && !quoted) {
			out.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	out.push(current);
	return out;
}

/**
 * The media type, cut back to a type and subtype this file is willing to write.
 *
 * The stored type is whatever the sender or the composer said -- `type` is an
 * unvalidated string on the send API -- and it is written as the part's
 * `Content-Type`. A stored `multipart/mixed; boundary="zz"` therefore turns
 * the part into a container, and the base64 inside it is read as a preamble:
 * the archive parses back with *no* attachment at all and nothing to say one
 * was lost. Stripping the line endings, as this did, does not touch that.
 *
 * Every parameter but `charset` goes with it. Dropping that one too was the
 * first attempt and it destroys mail this deployment actually carries: a
 * `text/plain; charset=Shift_JIS` attachment archived without its charset is
 * read back as UTF-8, and every byte of it becomes U+FFFD. The parameter that
 * makes a part a container is `boundary`; `charset` decides how bytes already
 * inside a leaf are read, and losing it is the same class of loss this file
 * exists to prevent.
 *
 * What this does not reach: received mail has no charset by the time it gets
 * here. postal-mime hands back a bare `mimeType` and the parameters are not on
 * the object at all, so the row records `text/plain` and the charset is gone
 * at ingest -- long before this. The archive of a *received* Shift_JIS message
 * is its raw copy, which still has it; a forwarded one is rebuilt from the row
 * and does not. Keeping the charset here is right and is not that fix.
 */
export function safeMediaType(value: string | null | undefined): string {
	const [rawType, ...params] = splitParameters(value ?? "");
	const bare = (rawType ?? "").trim().toLowerCase();
	const token = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
	if (!token.test(bare) || bare.startsWith("multipart/")) {
		return "application/octet-stream";
	}

	for (const param of params) {
		// A charset is a token: letters, digits and a little punctuation. Kept
		// as it was written, since charset names are matched case-insensitively
		// and Shift_JIS is not ours to rewrite -- but the *parameter name* is
		// matched that way too, and matching it case-sensitively dropped the
		// charset of a `CHARSET=Shift_JIS`, which is the loss this is for.
		const found = /^\s*charset\s*=\s*"?([A-Za-z0-9._:+-]+)"?\s*$/i.exec(param);
		if (found) return `${bare}; charset="${found[1]}"`;
	}
	return bare;
}

function base64Lines(bytes: Uint8Array): string {
	const lines: string[] = [];
	for (let at = 0; at < bytes.length; at += BASE64_LINE_BYTES) {
		const chunk = bytes.subarray(at, at + BASE64_LINE_BYTES);
		let binary = "";
		for (const byte of chunk) binary += String.fromCharCode(byte);
		lines.push(btoa(binary));
	}
	return lines.join("\r\n");
}

const GT = 0x3e; // ">"
const LF = 0x0a;
/** "From " -- the five bytes that begin an mbox separator line. */
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20];

/**
 * mbox delimits messages with a line beginning "From ", so any body line that
 * looks like one has to be quoted or the file splits in the wrong place. This
 * is the mboxrd convention: prefix with ">", and prefix an already-quoted one
 * again so the escaping can be undone exactly.
 *
 * Done on bytes, not on a string. A message is bytes -- plenty of Japanese
 * mail is 8-bit Shift_JIS or EUC-JP, and neither is valid UTF-8 -- so the
 * moment this took a string, the decode that produced it had already replaced
 * every such byte with U+FFFD and there was nothing left to escape correctly.
 * This scan only ever compares against ASCII, which no multi-byte encoding
 * puts in a trailing byte, so it is safe to run over bytes of any encoding.
 */
function escapeFromLines(message: Uint8Array): Uint8Array {
	const insertAt: number[] = [];

	let lineStart = 0;
	for (let i = 0; i <= message.length; i++) {
		if (i !== message.length && message[i] !== LF) continue;

		let p = lineStart;
		while (p < i && message[p] === GT) p++;
		if (i - p >= FROM.length && FROM.every((b, k) => message[p + k] === b)) {
			insertAt.push(lineStart);
		}
		lineStart = i + 1;
	}

	if (insertAt.length === 0) return message;

	const out = new Uint8Array(message.length + insertAt.length);
	let read = 0;
	let write = 0;
	for (const at of insertAt) {
		out.set(message.subarray(read, at), write);
		write += at - read;
		out[write++] = GT;
		read = at;
	}
	out.set(message.subarray(read), write);
	return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/** Fri Aug 29 04:39:21 2026 -- the ctime-ish stamp an mbox separator uses. */
function mboxDate(value: string | undefined): string {
	const date = value ? new Date(value) : new Date();
	const usable = Number.isNaN(date.getTime()) ? new Date(0) : date;
	return usable
		.toUTCString()
		.replace(
			/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/,
			"$1 $3 $2 $5 $4",
		);
}

async function synthesizeMessage(
	env: Env,
	email: ExportedEmail,
): Promise<string> {
	const attachments = email.attachments ?? [];
	const headers = [
		`From: ${email.sender ?? ""}`,
		`To: ${email.recipient ?? ""}`,
		`Subject: ${encodeHeader(email.subject ?? "")}`,
		`Date: ${new Date(email.date ?? Date.now()).toUTCString()}`,
		"MIME-Version: 1.0",
	];
	const body = email.body ?? "";

	if (attachments.length === 0) {
		headers.push('Content-Type: text/html; charset="utf-8"');
		return `${headers.join("\r\n")}\r\n\r\n${body}`;
	}

	const boundary = `----=_export_${email.id}`;
	headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

	const parts = [
		`--${boundary}`,
		'Content-Type: text/html; charset="utf-8"',
		"",
		body,
	];
	for (const attachment of attachments) {
		/*
		 * The key every writer uses: `attachments/{emailId}/{attachmentId}/
		 * {filename}` (index.ts, reply-forward.ts, email-ingest.ts, and the
		 * deletes in spam-purge-run.ts and mailbox-destroy.ts). This read asked
		 * for `attachments/{attachmentId}` and therefore always missed, and the
		 * miss was a `continue`.
		 *
		 * Only messages with no raw form reach here, which is every message
		 * this fork composed or forwarded. So a sent message with an attachment
		 * was archived without it, in a file nobody opens until the message is
		 * gone and the archive is the only copy left. Silently, which is the
		 * whole of what made it survive.
		 */
		const object = await env.BUCKET.get(
			`attachments/${email.id}/${attachment.id}/${attachment.filename}`,
		);
		// One line, for the note's prose as much as for its headers.
		const plainName = (attachment.filename || attachment.id).replace(
			/[\r\n]+/g,
			" ",
		);
		parts.push(`--${boundary}`);

		/*
		 * One that is genuinely gone says so, as a note rather than as a file.
		 *
		 * The headers are written here and not before the branch: a part with
		 * the original `Content-Type` *and* a second one for the note has two,
		 * and a reader keeps the first. postal-mime does exactly that -- it
		 * drops the marker and restores `note.bin` as a 36-byte file whose
		 * contents are the apology. A plausible corrupt file is worse than the
		 * silence this replaced, so the part is a text note throughout, named
		 * so that nothing mistakes it for the attachment.
		 */
		if (!object) {
			parts.push(
				'Content-Type: text/plain; charset="utf-8"',
				/*
				 * A file rather than an inline note, so that it survives being
				 * restored. Reading an archive back through this fork's own
				 * import takes the parsed HTML body and the parsed attachments;
				 * an inline text part is neither, so it was folded into the
				 * plain-text body and dropped, and the message came back with
				 * no attachment and nothing to say why.
				 *
				 * The suffix goes on before the encoding, not after: text after
				 * an encoded word is not part of it, and a conforming reader
				 * shows `=?UTF-8?B?...?=.missing.txt` literally.
				 */
				`Content-Disposition: attachment; filename=${quotedFilename(`${plainName}.missing.txt`)}`,
				"X-Email-Explorer-Attachment-Missing: 1",
				"",
				`[attachment ${attachment.id} (${plainName}) could not be read]`,
			);
			continue;
		}

		const bytes = new Uint8Array(await object.arrayBuffer());
		const type = safeMediaType(attachment.mimetype);
		/*
		 * An inline image is stored as one and was exported as an attachment
		 * with no Content-ID, so every `cid:` in the restored body pointed at
		 * nothing. The row has carried both fields the whole time.
		 *
		 * But `inline` is not free to write. A reader returns a text part as an
		 * attachment only when it is marked `attachment`: postal-mime folds an
		 * inline text/*, and message/rfc822 with it, into the body instead --
		 * measured, `attachments: 0` and the content spliced into both `text`
		 * and `html`. Writing it therefore costs those attachments their
		 * existence on the way back, in the file that is the last copy.
		 *
		 * So `inline` where it buys something and cannot cost anything: a
		 * non-text part that a `cid:` can actually refer to. Everything else
		 * keeps the disposition that survives, which is what every part had
		 * before Content-ID was written at all.
		 */
		const inline =
			attachment.disposition === "inline" &&
			!!attachment.content_id &&
			!/^(?:text|message)\//.test(type);
		parts.push(
			`Content-Type: ${type}`,
			`Content-Disposition: ${inline ? "inline" : "attachment"}; filename=${quotedFilename(plainName)}`,
		);
		if (attachment.content_id) {
			// Angle brackets are the syntax around it, not part of it.
			const cid = headerSafe(String(attachment.content_id)).replace(
				/[<>]/g,
				"",
			);
			if (cid) parts.push(`Content-ID: <${cid}>`);
		}
		parts.push("Content-Transfer-Encoding: base64", "", base64Lines(bytes));
	}
	parts.push(`--${boundary}--`);

	return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

/**
 * Header values must not carry a CR or LF: one would end the header early and
 * splice whatever followed into the message. Folder names come from the user,
 * so they are the one field here that could contain either.
 */
function headerSafe(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

/**
 * One mbox entry, as bytes. Mail that arrived from outside is written back
 * byte for byte from its stored raw copy; mail composed here never had a raw
 * form and is rebuilt from what was stored, attachments included.
 *
 * "Byte for byte" is why this returns bytes. It used to say so and not do it:
 * the raw copy was read with `.text()`, which decodes as UTF-8, and a message
 * that is not valid UTF-8 came out with U+FFFD where its bytes had been. Sent
 * a 8-bit Shift_JIS body of six bytes, the archive kept one of them. That is
 * unrecoverable, and it lands where it can least be afforded: deleting a
 * message removes its raw copy, so for anything deleted -- including every
 * message the nightly spam purge removes -- the archive is the only copy left.
 *
 * `folderName` is passed in rather than read off the row: the row holds a
 * folder id, and for a folder the user made that id is a uuid, which means
 * nothing in another mailbox. The name survives being restored somewhere else.
 *
 * The X-Email-Explorer-* headers carry what is true of the message here but is
 * not part of the message itself -- which folder it sat in, whether it had
 * been read or starred, when this mailbox recorded it, and the id it was
 * stored under. Without them a backup restores as a heap of unread mail in the
 * inbox. Other clients ignore headers they do not know, so the file stays a
 * plain mbox that Thunderbird can still read.
 */
export async function renderMboxEntry(
	env: Env,
	email: ExportedEmail,
	folderName?: string,
): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const raw = await env.BUCKET.get(`raw/${email.id}.eml`);
	// The one place the encoding is known: a message this fork composed is a
	// string it built itself, so encoding it as UTF-8 is what it already was.
	// A received message is never decoded at all.
	const message = raw
		? new Uint8Array(await raw.arrayBuffer())
		: encoder.encode(await synthesizeMessage(env, email));

	const separator = `From ${email.sender || "MAILER-DAEMON"} ${mboxDate(email.date)}`;
	const headers = [
		`X-Email-Explorer-Id: ${email.id}`,
		`X-Email-Explorer-Folder: ${headerSafe(folderName ?? email.folder_id ?? "inbox")}`,
		`X-Email-Explorer-Read: ${email.read ? "1" : "0"}`,
		`X-Email-Explorer-Starred: ${email.starred ? "1" : "0"}`,
	];
	if (email.date) headers.push(`X-Email-Explorer-Date: ${email.date}`);

	return concatBytes([
		encoder.encode(`${separator}\r\n${headers.join("\r\n")}\r\n`),
		escapeFromLines(message),
		encoder.encode("\r\n\r\n"),
	]);
}
