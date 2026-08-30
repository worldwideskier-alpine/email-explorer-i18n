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
	// Printable ASCII only; anything outside it needs encoding.
	if (!/[^ -~]/.test(value)) return value;
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `=?UTF-8?B?${btoa(binary)}?=`;
}

function base64Lines(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return (btoa(binary).match(/.{1,76}/g) ?? []).join("\r\n");
}

/**
 * mbox delimits messages with a line beginning "From ", so any body line that
 * looks like one has to be quoted or the file splits in the wrong place. This
 * is the mboxrd convention: prefix with ">", and prefix an already-quoted one
 * again so the escaping can be undone exactly.
 */
function escapeFromLines(message: string): string {
	return message.replace(/^(>*From )/gm, ">$1");
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
		const object = await env.BUCKET.get(`attachments/${attachment.id}`);
		if (!object) continue;
		const bytes = new Uint8Array(await object.arrayBuffer());
		parts.push(
			`--${boundary}`,
			`Content-Type: ${attachment.mimetype || "application/octet-stream"}`,
			`Content-Disposition: attachment; filename="${encodeHeader(attachment.filename || attachment.id)}"`,
			"Content-Transfer-Encoding: base64",
			"",
			base64Lines(bytes),
		);
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
 * One mbox entry. Mail that arrived from outside is written back byte for
 * byte from its stored raw copy, so nothing is lost in translation; mail
 * composed here never had a raw form and is rebuilt from what was stored,
 * attachments included.
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
): Promise<string> {
	const raw = await env.BUCKET.get(`raw/${email.id}.eml`);
	const message = raw ? await raw.text() : await synthesizeMessage(env, email);

	const separator = `From ${email.sender || "MAILER-DAEMON"} ${mboxDate(email.date)}`;
	const headers = [
		`X-Email-Explorer-Id: ${email.id}`,
		`X-Email-Explorer-Folder: ${headerSafe(folderName ?? email.folder_id ?? "inbox")}`,
		`X-Email-Explorer-Read: ${email.read ? "1" : "0"}`,
		`X-Email-Explorer-Starred: ${email.starred ? "1" : "0"}`,
	];
	if (email.date) headers.push(`X-Email-Explorer-Date: ${email.date}`);

	return `${separator}\r\n${headers.join("\r\n")}\r\n${escapeFromLines(message)}\r\n\r\n`;
}
