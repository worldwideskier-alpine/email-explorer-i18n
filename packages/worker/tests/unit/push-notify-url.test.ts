import { describe, expect, it } from "vitest";
import { mailboxInboxPath } from "../../src/push-notify";

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
