import { describe, expect, it } from "vitest";
import { buildNewEmailPayload, mailboxEmailPath } from "../../src/push-notify";

// The notification tapped on the phone opens this path, which must match the
// router's `email/:id` child route (singular "email", no "s") and carry the
// fromFolder query EmailDetail reads for its back/move actions.
describe("mailboxEmailPath", () => {
	it("builds the EmailDetail route for a specific message", () => {
		expect(mailboxEmailPath("uota@beautifulsnow.co.jp", "abc-123")).toBe(
			"/mailbox/uota%40beautifulsnow.co.jp/email/abc-123?fromFolder=inbox",
		);
	});

	it("uses the singular email/ segment, not the emails/ list route", () => {
		const path = mailboxEmailPath("a@b.com", "id1");
		expect(path).toContain("/email/id1");
		expect(path).not.toContain("/emails/");
	});

	it("percent-encodes the mailbox address", () => {
		expect(mailboxEmailPath("info@beautifulsnow.co.jp", "x")).toContain("%40");
	});
});

// Gmail-style stacking depends entirely on each message getting its own
// notification tag: Android replaces a same-tag notification in place, so a
// shared tag would collapse every new mail into one row.
describe("buildNewEmailPayload", () => {
	const mk = (id: string, sender: string, subject: string) =>
		buildNewEmailPayload("uota@beautifulsnow.co.jp", "UOTA Yuji", {
			id,
			sender,
			subject,
		});

	it("tags each notification with its own email id", () => {
		expect(mk("id-1", "a@x.com", "s1").tag).toBe("id-1");
		expect(mk("id-2", "b@x.com", "s2").tag).toBe("id-2");
	});

	it("leads the title with the mailbox label so mailboxes stay tellable apart", () => {
		expect(
			mk("id-1", "Dorothee@team-asia.co.jp", "8月お支払金額のお知らせ"),
		).toMatchObject({
			title: "[UOTA Yuji] Dorothee@team-asia.co.jp",
			body: "8月お支払金額のお知らせ",
		});
	});

	it("links each notification to its own message", () => {
		expect(mk("id-1", "a@x.com", "s1").url).toBe(
			"/mailbox/uota%40beautifulsnow.co.jp/email/id-1?fromFolder=inbox",
		);
	});

	it("falls back to the mailbox id when the sender is missing", () => {
		expect(mk("id-1", "", "s1").title).toBe(
			"[UOTA Yuji] uota@beautifulsnow.co.jp",
		);
	});
});
