import { describe, expect, it } from "vitest";
import { attachmentKey, parseAttachmentKey } from "../../src/attachment-sweep";

/**
 * Reading an attachment key back into the three things it was built from.
 *
 * The sweep decides what to do with an object by comparing the key it found
 * against the key the row gives, so a key read wrongly is an object reported
 * wrongly -- and the report is what somebody presses "delete" on.
 *
 * The part that is not obvious is the filename. It is the last segment only
 * in the sense that it is everything after the second slash: a name that
 * arrived with a slash in it ("2026/tax.pdf" is a legal filename to receive)
 * makes a key with four segments, and splitting on every slash reads the name
 * as "2026" -- which does not match the row, so a perfectly good attachment is
 * reported as misnamed and a repair would move it on top of itself.
 */

describe("reading an attachment key", () => {
	it("splits on the first two slashes and no others", () => {
		expect(parseAttachmentKey("attachments/e1/a1/report.pdf")).toEqual({
			emailId: "e1",
			attachmentId: "a1",
			filename: "report.pdf",
		});
		expect(parseAttachmentKey("attachments/e1/a1/2026/tax.pdf")).toEqual({
			emailId: "e1",
			attachmentId: "a1",
			filename: "2026/tax.pdf",
		});
	});

	it("round-trips whatever it read", () => {
		for (const key of [
			"attachments/e1/a1/report.pdf",
			"attachments/e1/a1/2026/tax.pdf",
			"attachments/e1/a1/null",
			"attachments/e-1/a_1/名前.pdf",
		]) {
			const parsed = parseAttachmentKey(key);
			expect(parsed).toBeTruthy();
			expect(attachmentKey(parsed as never)).toBe(key);
		}
	});

	// Anything else is reported as unreadable rather than guessed at. A key
	// with a part missing names no row, and treating it as one would put an
	// object in a class that has a delete button.
	it("refuses what is not an attachment key", () => {
		for (const key of [
			"raw/e1.eml",
			"mailboxes/a@b.json",
			"attachments/",
			"attachments/e1",
			"attachments/e1/",
			"attachments//a1/name",
			"attachments/e1//name",
		]) {
			expect(parseAttachmentKey(key), key).toBeNull();
		}
	});
});
