import { safeMediaType } from "./mbox";

/**
 * Which attachments open in the browser rather than being saved: a PDF or a
 * picture, and nothing else.
 *
 * Shown inline, an attachment is the sender's file rendered at this
 * dashboard's origin. Measured in Chromium: an HTML or an SVG file shown that
 * way ran its script and read the session the dashboard keeps in storage. A
 * PDF is drawn by the browser's own viewer and a picture as a picture, with no
 * script of this origin in either, and with `nosniff` bytes that only claim to
 * be a picture -- HTML sent as image/png, measured -- are a broken picture and
 * nothing more. Everything else, an archive included, is still a download; a
 * browser that cannot show one of these saves it instead.
 *
 * Decided by the type the attachment is served with, never by its name: the
 * name is the sender's too, and the type is what the browser goes by.
 */
const OPENS_INLINE = new Set([
	"application/pdf",
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
]);

/** Whether an attachment of this declared type is served to be shown. */
export function opensInline(mimetype: string | null | undefined): boolean {
	const [bare = ""] = safeMediaType(mimetype).split(";");
	return OPENS_INLINE.has(bare.trim());
}
