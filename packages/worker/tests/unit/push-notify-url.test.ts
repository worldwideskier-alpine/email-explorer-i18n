import { describe, expect, it } from "vitest";
import { mailboxEmailPath, mailboxInboxPath } from "../../src/push-notify";

// The dashboard router (packages/dashboard/src/router/index.ts) defines the
// inbox list as `/mailbox/:mailboxId/emails/:folder`, with a catch-all
// NotFound route swallowing everything else. A notification pointing at a
// path that doesn't match a real route silently 404s when tapped, so pin
// the exact shape here.
describe("mailboxInboxPath", () => {
	it("includes the emails/ segment the EmailList route requires", () => {
		expect(mailboxInboxPath("uota@beautifulsnow.co.jp")).toBe(
			"/mailbox/uota%40beautifulsnow.co.jp/emails/inbox",
		);
	});

	it("percent-encodes the @ in the mailbox address", () => {
		expect(mailboxInboxPath("info@beautifulsnow.co.jp")).toContain("%40");
		expect(mailboxInboxPath("info@beautifulsnow.co.jp")).not.toContain("@");
	});

	it("produces a path that starts at the site root", () => {
		expect(mailboxInboxPath("a@b.com").startsWith("/mailbox/")).toBe(true);
	});
});

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
