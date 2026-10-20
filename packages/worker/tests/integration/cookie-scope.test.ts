import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	sessionToken,
	testAuthBeforeAll,
	userId,
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
		// Answered -- the route is public, so a sign-out that arrives after
		// the session ran out still ends it -- but it names no session, so
		// it ends none, and leaves the cookie the inline pictures need.
		expect(pinged.status).toBe(200);
		expect(pinged.headers.get("Set-Cookie")).toBeNull();
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

/**
 * A sign-out the dashboard sends again from an earlier session
 * (finishPendingSignOut) goes out with the cookie of whoever is signed in
 * now. It ends the session it names, and leaves theirs: clearing the cookie
 * whatever it held took the current person's inline pictures with it until
 * their next sign-in.
 */
describe("a sign-out of another session", () => {
	const earlier = "an-earlier-session";

	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await runInDurableObject(
			env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")),
			async (_i, state) => {
				state.storage.sql.exec(
					"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
					earlier,
					userId,
					Date.now() + 60_000,
					Date.now(),
				);
			},
		);
	});

	const signOut = (named: string) =>
		withCookie("/api/v1/auth/logout", {
			method: "POST",
			headers: { Authorization: `Bearer ${named}` },
		});

	it("ends that one and leaves the cookie of the session signed in now", async () => {
		const res = await signOut(earlier);
		expect(res.status).toBe(200);
		expect(res.headers.get("Set-Cookie")).toBeNull();
		const asEarlier = await SELF.fetch(url("/api/v1/auth/me"), {
			headers: { Authorization: `Bearer ${earlier}` },
		});
		expect(asEarlier.status).toBe(401);
		const mailbox = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`;
		const picture = await withCookie(
			`${mailbox}/emails/no-such-email/attachments/no-such-attachment`,
			{ headers: { "Sec-Fetch-Dest": "image" } },
		);
		expect(picture.status).toBe(404);
	});

	it("clears the cookie when it is the session being ended", async () => {
		const res = await signOut(sessionToken);
		expect(res.status).toBe(200);
		expect(res.headers.get("Set-Cookie")).toMatch(/^session=;.*Max-Age=0/);
	});
});
