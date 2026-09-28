import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The API is not something a page loads on its own.
 *
 * A message is shown in a frame of this page's origin, so an address it names
 * by a path here is fetched with the reader's session: measured in Chromium,
 * an `<img>` pointing at a mailbox route went out with the cookie and was
 * answered. The browser says what a request is for, and only the dashboard's
 * own calls, a person's navigation and an inline picture are answered.
 */

const as = (dest: string | null, path: string) =>
	authenticatedFetch(`http://local.test${path}`, {
		headers: dest ? { "Sec-Fetch-Dest": dest } : {},
	});

describe("a request the browser says a page is loading", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	const mailbox = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`;

	for (const dest of ["image", "style", "font", "video", "audio", "object"]) {
		it(`is refused as ${dest}`, async () => {
			const res = await as(dest, `${mailbox}/export`);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "Not loadable from a page" });
		});
	}

	it("is refused for every route, not only the heavy ones", async () => {
		expect((await as("image", `${mailbox}/folders`)).status).toBe(403);
		expect((await as("image", "/api/v1/auth/me")).status).toBe(403);
	});

	// An inline picture is an attachment loaded as an image: still answered,
	// by the route's own rules.
	it("is answered for an attachment", async () => {
		const res = await as(
			"image",
			`${mailbox}/emails/no-such-email/attachments/no-such-attachment`,
		);
		expect(res.status).not.toBe(403);
	});
});

describe("the requests that are the dashboard's own", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	const folders = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders`;

	it("are answered as fetches", async () => {
		expect((await as("empty", folders)).status).toBe(200);
	});

	it("are answered as a person's navigation", async () => {
		expect((await as("document", folders)).status).toBe(200);
	});

	it("are answered from a browser that does not say", async () => {
		expect((await as(null, folders)).status).toBe(200);
	});
});
