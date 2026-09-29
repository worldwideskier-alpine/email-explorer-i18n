/**
 * The copy of an outgoing message kept in Sent, and the order it is made in.
 *
 * Sending comes first: a copy in Sent of a message that never left would say
 * it had. But everything that can refuse the message has to be asked before
 * it leaves, not after -- the attachments used to be decoded after Resend
 * had taken them, so one that was not valid base64 went out and then failed
 * the request with a 500. And once the message has left, failing to file the
 * copy is not a failed send: answering 500 then invited a retry, which sent
 * the message a second time. The copy's failure is logged and said, and the
 * send is answered as the success it was.
 */

import { storableFilename } from "./attachment-name";
import { base64ToBytes } from "./base64";
import type { MailboxDO } from "./durableObject";
import type { Env } from "./types";

type SentRow = Omit<Parameters<MailboxDO["createEmail"]>[1], "id">;

export interface OutgoingAttachment {
	filename?: string;
	content?: string;
	type?: string;
	contentId?: string | null;
	disposition?: string;
}

export interface PreparedAttachment {
	attachment: OutgoingAttachment;
	bytes: Uint8Array;
}

/** Decoded before sending; null when one of them is not base64. */
export function prepareAttachments(
	attachments: OutgoingAttachment[] | undefined,
): PreparedAttachment[] | null {
	try {
		return (attachments ?? []).map((attachment) => ({
			attachment,
			bytes: base64ToBytes(attachment.content ?? ""),
		}));
	} catch {
		return null;
	}
}

/** Files the copy; answers whether it was filed. Never throws. */
export async function keepSentCopy(
	env: Env,
	stub: DurableObjectStub<MailboxDO>,
	messageId: string,
	row: SentRow,
	prepared: PreparedAttachment[],
): Promise<boolean> {
	try {
		const rows: Parameters<MailboxDO["createEmail"]>[2] = [];
		for (const { attachment, bytes } of prepared) {
			const attachmentId = crypto.randomUUID();
			// The same name for key and row; see attachment-name.ts.
			const filename = storableFilename(attachment.filename);
			await env.BUCKET.put(
				`attachments/${messageId}/${attachmentId}/${filename}`,
				bytes,
			);
			rows.push({
				id: attachmentId,
				email_id: messageId,
				filename,
				mimetype: attachment.type ?? "application/octet-stream",
				size: bytes.length,
				content_id: attachment.contentId || null,
				disposition: attachment.disposition,
			});
		}
		await stub.createEmail("sent", { id: messageId, ...row }, rows);
		return true;
	} catch (e) {
		console.error(`Sent ${messageId}, but could not keep a copy:`, e);
		return false;
	}
}
