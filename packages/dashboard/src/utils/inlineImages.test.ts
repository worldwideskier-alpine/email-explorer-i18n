import { describe, expect, it } from "vitest";
import { filenameFrom, quotedPictures, withContentIds } from "./inlineImages";

const HERE = "/api/v1/mailboxes/m@example.com/emails/e1/attachments/a1";

describe("quotedPictures", () => {
	it("finds a picture of this deployment's by its address", () => {
		expect(quotedPictures(`<p><img src="${HERE}"></p>`)).toEqual([
			{
				src: HERE,
				mailboxId: "m@example.com",
				emailId: "e1",
				attachmentId: "a1",
			},
		]);
	});

	it("reads an encoded mailbox as the mailbox", () => {
		const encoded = `/api/v1/mailboxes/${encodeURIComponent("m@example.com")}/emails/e1/attachments/a1`;
		expect(quotedPictures(`<img src="${encoded}">`)[0].mailboxId).toBe(
			"m@example.com",
		);
	});

	// Only pictures: an address written in a sentence stays as it was.
	it("leaves an address that is only text, and pictures from elsewhere", () => {
		expect(
			quotedPictures(
				`<p>${HERE}</p><img src="https://elsewhere.example${HERE}"><img src="cid:x">`,
			),
		).toEqual([]);
	});
});

describe("withContentIds", () => {
	it("puts every such picture back to a cid:, another mailbox's too", () => {
		const other = "/api/v1/mailboxes/o@example.com/emails/e9/attachments/a9";
		const html = `<img src="${HERE}"><img src="${other}"><p>${HERE}?</p>`;
		const out = withContentIds(html, quotedPictures(html));
		expect(out).toContain('<img src="cid:a1">');
		expect(out).toContain('<img src="cid:a9">');
		expect(out).not.toContain("/mailboxes/o@example.com");
	});
});

describe("filenameFrom", () => {
	it("takes the name the Worker gave, encoded or not", () => {
		expect(
			filenameFrom(
				`attachment; filename="_.png"; filename*=UTF-8''%E3%83%AD%E3%82%B4.png`,
			),
		).toBe("ロゴ.png");
		expect(filenameFrom('attachment; filename="logo.png"')).toBe("logo.png");
		expect(filenameFrom(undefined)).toBe("image");
	});
});
