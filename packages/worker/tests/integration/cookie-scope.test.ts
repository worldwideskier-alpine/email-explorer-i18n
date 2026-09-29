import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	sessionToken,
	testAuthBeforeAll,
} from "./utils";

/**
 * The session cookie signs in only what cannot carry the bearer token: an
 * attachment read (an inline picture in a message) and `/docs` with its
 * `/openapi.json`. Everything else needs the header.
 *
 * A message is shown in a frame of this page's origin, so what it names by a
 * path here goes out with the reader's cookie. Measured in Chromium, in the
 * inbox: `<link rel=prefetch>` at the export was answered with the mailbox,
 * and `<a ping>` at the logout signed the reader out when the link was
 * tapped. Neither can add a header, so neither signs in any more.
 */

const url = (path: string) => `http://local.test${path}`;
const withCookie = (path: string, init: RequestInit = {}) =>
	SELF.fetch(url(path), {
		...init,
		headers: { ...init.headers, Cookie: `session=${sessionToken}` },
	});

describe("the session cookie alone", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	const mailbox = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`;

	it("does not read a mailbox", async () => {
		// What a message's <link rel=prefetch> sends.
		expect((await withCookie(`${mailbox}/export`)).status).toBe(401);
		expect((await withCookie(`${mailbox}/folders`)).status).toBe(401);
		expect((await withCookie("/api/v1/auth/me")).status).toBe(401);
	});

	it("does not sign the reader out", async () => {
		// What a message's <a ping> sends when the link is tapped.
		const pinged = await withCookie("/api/v1/auth/logout", {
			method: "POST",
			headers: { "Content-Type": "text/ping", "Ping-To": "https://x.test/" },
			body: "PING",
		});
		expect(pinged.status).toBe(401);
		expect((await authenticatedFetch(url("/api/v1/auth/me"))).status).toBe(200);
	});

	it("does not change anything, even at an attachment's path", async () => {
		const attachment = `${mailbox}/emails/no-such-email/attachments/no-such-attachment`;
		for (const method of ["POST", "PUT", "DELETE"]) {
			expect((await withCookie(attachment, { method })).status).toBe(401);
		}
	});

	it("still reads an attachment, which is what an inline picture is", async () => {
		// Signed in, so the route itself answers: there is no such attachment.
		const res = await withCookie(
			`${mailbox}/emails/no-such-email/attachments/no-such-attachment`,
			{ headers: { "Sec-Fetch-Dest": "image" } },
		);
		expect(res.status).toBe(404);
	});

	it("still opens the API's documentation", async () => {
		expect((await withCookie("/openapi.json")).status).toBe(200);
		expect(
			(await withCookie("/docs", { headers: { "Sec-Fetch-Dest": "document" } }))
				.status,
		).toBe(200);
	});
});
