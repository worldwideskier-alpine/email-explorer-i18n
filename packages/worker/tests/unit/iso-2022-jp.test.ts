import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";

/**
 * ISO-2022-JP is read as mail clients read it (patches/postal-mime.patch).
 *
 * A card company's statement notice, 2026-11-14, wrote its card name and the
 * sentence after it as two JIS runs, the first closed and the next opened at
 * once: `ESC ( B ESC $ B`. The Encoding Standard's decoder, which this
 * runtime's TextDecoder follows as a browser's does, answers U+FFFD for an
 * escape sequence that follows another with nothing between them, and the
 * screen showed a replacement character between "）" and "を" that the
 * sender never wrote. Python and iconv read the same bytes as "）を".
 *
 * The names and words here are made up; the byte pattern is the message's.
 */

const ESC = "\x1b";
const SPLIT_RUNS = `${ESC}$B!K${ESC}(B${ESC}$B$r${ESC}(B`; // "）" then "を"

function message(headers: string, body: string): Uint8Array {
	return new TextEncoder().encode(
		`From: notice@example.com\r\nTo: reader@example.com\r\nMIME-Version: 1.0\r\n${headers}\r\n\r\n${body}`,
	);
}

function base64OfBytes(text: string): string {
	return btoa(text);
}

describe("ISO-2022-JP, as mail clients read it", () => {
	it("reads two JIS runs written one after the other as the sender wrote them", async () => {
		// The message's own shape: quoted-printable, a soft break inside a run.
		const email = await PostalMime.parse(
			message(
				'Subject: x\r\nContent-Type: text/html; charset="iso-2022-jp"\r\nContent-Transfer-Encoding: quoted-printable',
				"<td>=1B$B!K=1B(B=1B$B$=\r\nr=1B(B</td>\r\n",
			),
		);
		expect(email.html).toContain("<td>）を</td>");
		expect(email.html).not.toContain("�");
	});

	it("reads them so in a 7bit text part and a base64 one alike", async () => {
		const plain = await PostalMime.parse(
			message(
				'Subject: x\r\nContent-Type: text/plain; charset="iso-2022-jp"\r\nContent-Transfer-Encoding: 7bit',
				`${SPLIT_RUNS}\r\n`,
			),
		);
		expect(plain.text?.trim()).toBe("）を");

		const encoded = await PostalMime.parse(
			message(
				'Subject: x\r\nContent-Type: text/plain; charset="iso-2022-jp"\r\nContent-Transfer-Encoding: base64',
				`${base64OfBytes(SPLIT_RUNS)}\r\n`,
			),
		);
		expect(encoded.text?.trim()).toBe("）を");
	});

	it("reads them so in an encoded-word header", async () => {
		const email = await PostalMime.parse(
			message(
				`Subject: =?iso-2022-jp?B?${base64OfBytes(SPLIT_RUNS)}?=\r\nContent-Type: text/plain; charset=us-ascii`,
				"x\r\n",
			),
		);
		expect(email.subject).toBe("）を");
	});

	it("takes the last of a longer run of escape sequences", async () => {
		const email = await PostalMime.parse(
			message(
				'Subject: x\r\nContent-Type: text/plain; charset="iso-2022-jp"\r\nContent-Transfer-Encoding: 7bit',
				`${ESC}$B!K${ESC}(B${ESC}(J${ESC}$@$r${ESC}(B\r\n`,
			),
		);
		expect(email.text?.trim()).toBe("）を");
	});

	it("still marks a byte that is not ISO-2022-JP, and an escape it does not know", async () => {
		// Hiding a real fault would be the opposite mistake: these stay U+FFFD.
		const stray = await PostalMime.parse(
			message(
				'Subject: x\r\nContent-Type: text/plain; charset="iso-2022-jp"\r\nContent-Transfer-Encoding: 8bit',
				`${ESC}$B!K\xae${ESC}(B\r\n`,
			),
		);
		expect(stray.text).toContain("�");

		// An escape the decoder does not recognise after one it does: the one
		// it recognises is kept, so the text after is read in its mode (ASCII),
		// as it was before -- not in the JIS mode a dropped `ESC ( B` would
		// have left in force.
		const unknown = await PostalMime.parse(
			message(
				'Subject: x\r\nContent-Type: text/plain; charset="iso-2022-jp"\r\nContent-Transfer-Encoding: 7bit',
				`${ESC}$B!K${ESC}(B${ESC}$(D!K\r\n`,
			),
		);
		expect(unknown.text).toContain("�");
		expect(unknown.text).toContain("!K");
		expect(unknown.text).not.toContain("））");
	});

	it("leaves every other charset to the decoder as it was", async () => {
		// Shift_JIS bytes for "）を", not touched by the ISO-2022-JP reading.
		const email = await PostalMime.parse(
			new Uint8Array([
				...new TextEncoder().encode(
					"From: notice@example.com\r\nTo: reader@example.com\r\nMIME-Version: 1.0\r\nSubject: x\r\nContent-Type: text/plain; charset=shift_jis\r\nContent-Transfer-Encoding: 8bit\r\n\r\n",
				),
				0x81,
				0x6a,
				0x82,
				0xf0,
				0x0d,
				0x0a,
			]),
		);
		expect(email.text?.trim()).toBe("）を");
	});
});
