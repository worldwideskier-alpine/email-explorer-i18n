import { describe, expect, it } from "vitest";
import { buildNewEmailPayload, mailboxEmailPath } from "../../src/push-notify";

// The notification tapped on the phone opens this path, which must match the
// router's `email/:id` child route (singular "email", no "s") and carry the
// fromFolder query EmailDetail reads for its back/move actions.
describe("mailboxEmailPath", () => {
	it("builds the EmailDetail route for a specific message", () => {
		expect(mailboxEmailPath("owner@mailbox.example", "abc-123")).toBe(
			"/mailbox/owner%40mailbox.example/email/abc-123?fromFolder=inbox",
		);
	});

	it("uses the singular email/ segment, not the emails/ list route", () => {
		const path = mailboxEmailPath("a@b.com", "id1");
		expect(path).toContain("/email/id1");
		expect(path).not.toContain("/emails/");
	});

	it("percent-encodes the mailbox address", () => {
		expect(mailboxEmailPath("info@mailbox.example", "x")).toContain("%40");
	});
});

// Gmail-style stacking depends entirely on each message getting its own
// notification tag: Android replaces a same-tag notification in place, so a
// shared tag would collapse every new mail into one row.
describe("buildNewEmailPayload", () => {
	const mk = (id: string, sender: string, subject: string) =>
		buildNewEmailPayload("owner@mailbox.example", "Mailbox Owner", {
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
			mk("id-1", "billing@vendor.example", "請求書のご案内"),
		).toMatchObject({
			title: "[Mailbox Owner] billing@vendor.example",
			body: "請求書のご案内",
		});
	});

	it("links each notification to its own message", () => {
		expect(mk("id-1", "a@x.com", "s1").url).toBe(
			"/mailbox/owner%40mailbox.example/email/id-1?fromFolder=inbox",
		);
	});

	it("falls back to the mailbox id when the sender is missing", () => {
		expect(mk("id-1", "", "s1").title).toBe(
			"[Mailbox Owner] owner@mailbox.example",
		);
	});
});
