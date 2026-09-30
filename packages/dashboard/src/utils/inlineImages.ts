/**
 * Inline pictures: a message's `cid:` references, on the way in and out.
 *
 * A received message names its inline pictures by Content-ID, and nothing on
 * this page can load `cid:`. Reading it, the references are swapped for the
 * attachments' addresses here. Quoting it into a reply or forward does the
 * same, so the picture shows in the editor -- and then the addresses have to
 * be swapped back on the way out, with the pictures attached, or the
 * recipient is sent an address on this deployment that they cannot open and
 * that names the mailbox.
 */

import { bytesToBase64 } from "@/utils/attachments";

/** What decides whether an attachment is one of the message's pictures. */
export interface InlineCandidate {
	id: string;
	content_id?: string | null;
	disposition?: string | null;
}

export const attachmentPath = (
	mailboxId: string,
	emailId: string,
	attachmentId: string,
) =>
	`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`;

/**
 * Rewrites the body's `cid:` references into attachment URLs and records
 * which attachments were consumed that way.
 *
 * An inline disposition alone doesn't mean the image is visible: senders
 * (Outlook especially) mark every signature and layout image "inline" even
 * when the HTML never references it. Only an attachment whose cid was
 * actually substituted into the body counts as displayed, so anything the
 * reader can't already see stays listed under the attachments.
 *
 * Substitution uses split/join rather than a RegExp because a content id may
 * contain regex metacharacters, and because the "did anything change?" test
 * is then exactly the substitution itself.
 */
export function substituteInlineImages(
	body: string,
	attachments: readonly InlineCandidate[],
	urlOf: (attachmentId: string) => string,
): { html: string; inlineIds: Set<string> } {
	const inlineIds = new Set<string>();
	let html = body;
	const bare = (contentId: string) =>
		contentId.startsWith("<") ? contentId.slice(1, -1) : contentId;

	// Longest first. `cid:img1` is also the start of `cid:img10`, so taking
	// img1 first rewrote img10's reference into img1's address with a "0"
	// after it -- a broken picture, and img10 offered as a download too. Once
	// the longer one has been replaced there is no `cid:` left for the shorter
	// one to match inside it.
	const inline = attachments
		.filter((a) => a.disposition === "inline" && a.content_id)
		.sort(
			(a, b) =>
				bare(b.content_id ?? "").length - bare(a.content_id ?? "").length,
		);

	for (const attachment of inline) {
		const cid = bare(attachment.content_id ?? "");
		const substituted = html.split(`cid:${cid}`).join(urlOf(attachment.id));

		if (substituted !== html) {
			html = substituted;
			inlineIds.add(attachment.id);
		}
	}

	return { html, inlineIds };
}

/** A picture in outgoing HTML that is one of this deployment's attachments. */
export interface QuotedPicture {
	/** The `src` exactly as written, which is what gets replaced. */
	src: string;
	mailboxId: string;
	emailId: string;
	attachmentId: string;
}

const ATTACHMENT_PATH =
	/^\/api\/v1\/mailboxes\/([^/?#]+)\/emails\/([^/?#]+)\/attachments\/([^/?#]+)$/;

const decoded = (segment: string) => {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
};

/**
 * Every `<img>` in the HTML whose source is an attachment of this
 * deployment, by the address the page loads it from. Read from the parsed
 * markup rather than matched in the text, so an address that is only written
 * in a sentence is not taken for a picture to send.
 */
export function quotedPictures(html: string): QuotedPicture[] {
	if (!html.includes("/attachments/")) return [];
	const doc = new DOMParser().parseFromString(html, "text/html");
	const found: QuotedPicture[] = [];
	for (const img of doc.querySelectorAll("img")) {
		const src = img.getAttribute("src");
		if (!src) continue;
		let url: URL;
		try {
			url = new URL(src, window.location.origin);
		} catch {
			continue;
		}
		if (url.origin !== window.location.origin) continue;
		const match = ATTACHMENT_PATH.exec(url.pathname);
		if (!match) continue;
		const [mailboxId, emailId, attachmentId] = match.slice(1).map(decoded) as (
			| string
			| null
		)[];
		if (!mailboxId || !emailId || !attachmentId) continue;
		found.push({ src, mailboxId, emailId, attachmentId });
	}
	return found;
}

/**
 * The HTML as it leaves: each picture's address replaced by `cid:` and the
 * attachment id, which is what the attachment sent with it is named by.
 * Wherever the address appears, a sentence included: it names the mailbox,
 * and the recipient cannot open it. Both spellings are replaced, since a
 * serialiser writes `&` in an attribute as `&amp;`.
 */
export function withContentIds(
	html: string,
	pictures: readonly QuotedPicture[],
): string {
	let out = html;
	for (const picture of pictures) {
		const cid = `cid:${picture.attachmentId}`;
		out = out.split(picture.src).join(cid);
		out = out.split(picture.src.replace(/&/g, "&amp;")).join(cid);
	}
	return out;
}

/** An inline attachment in the shape the send API takes. */
export interface OutgoingInline {
	content: string;
	filename: string;
	type: string;
	size: number;
	disposition: "inline";
	contentId: string;
}

/** The name the Worker gave the file, from its Content-Disposition. */
export function filenameFrom(disposition: string | undefined): string {
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "")?.[1];
	if (encoded) {
		const name = decoded(encoded.trim());
		if (name) return name;
	}
	return /filename="([^"]*)"/i.exec(disposition ?? "")?.[1] || "image";
}

/** Bytes fetched for a picture, turned into the attachment that carries it. */
export async function asInlineAttachment(
	picture: QuotedPicture,
	blob: Blob,
	disposition: string | undefined,
): Promise<OutgoingInline> {
	return {
		content: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
		filename: filenameFrom(disposition),
		type: blob.type || "application/octet-stream",
		size: blob.size,
		disposition: "inline",
		contentId: picture.attachmentId,
	};
}
