import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import SOURCE from "../../src/index.ts?raw";
import { authenticatedFetch, testAuthBeforeAll } from "./utils";

/**
 * Who may reach each route, as one table.
 *
 * Every other test asks about the route it is about. This asks every route
 * the same three questions -- without a session, as somebody who does not
 * hold the mailbox, as somebody who is not root -- so a route added without
 * its gate fails here whatever else it does. And the table has to name every
 * route the Worker registers: a new one is classified before this passes.
 */

type Access = "public" | "session" | "holder" | "root";

const TABLE: Record<string, Access> = {
	"POST /api/v1/auth/register": "public",
	"POST /api/v1/auth/login": "public",
	"POST /api/v1/auth/forgot-password": "public",
	"POST /api/v1/auth/reset-password": "public",
	"POST /api/v1/auth/confirm-email-change": "public",
	"GET /api/v1/settings": "public",

	"POST /api/v1/auth/logout": "session",
	"GET /api/v1/auth/me": "session",
	"POST /api/v1/auth/change-password": "session",
	"POST /api/v1/auth/change-email": "session",
	"POST /api/v1/auth/admin/register": "session",
	"GET /api/v1/auth/admin/users": "session",
	"DELETE /api/v1/auth/admin/users/:userId": "session",
	"GET /api/v1/push/vapid-public-key": "session",
	"POST /api/v1/push/subscribe": "session",
	"POST /api/v1/push/unsubscribe": "session",
	"GET /api/v1/admin/settings/resend": "session",
	"PUT /api/v1/admin/settings/resend": "session",
	"GET /api/v1/mailboxes": "session",
	"POST /api/v1/mailboxes": "session",

	"GET /api/v1/root/accounts": "root",
	"GET /api/v1/root/maintenance": "root",
	"POST /api/v1/root/accounts": "root",
	"POST /api/v1/root/accounts/:userId/password": "root",
	"POST /api/v1/root/accounts/:personId/lock": "root",
	"DELETE /api/v1/root/accounts/:personId": "root",
	"GET /api/v1/root/attachments": "root",
	"POST /api/v1/root/attachments/repair": "root",
	"POST /api/v1/root/attachments/purge": "root",

	"POST /api/v1/admin/mailboxes/:mailboxId/import": "holder",
	"GET /api/v1/mailboxes/:mailboxId": "holder",
	"PUT /api/v1/mailboxes/:mailboxId": "holder",
	"DELETE /api/v1/mailboxes/:mailboxId": "holder",
	"GET /api/v1/mailboxes/:mailboxId/export": "holder",
	"POST /api/v1/mailboxes/:mailboxId/spam-filter/check": "holder",
	"GET /api/v1/mailboxes/:mailboxId/backups": "holder",
	"GET /api/v1/mailboxes/:mailboxId/backups/:name": "holder",
	"GET /api/v1/mailboxes/:mailboxId/emails": "holder",
	"POST /api/v1/mailboxes/:mailboxId/emails": "holder",
	"GET /api/v1/mailboxes/:mailboxId/emails/:id": "holder",
	"PUT /api/v1/mailboxes/:mailboxId/emails/:id": "holder",
	"DELETE /api/v1/mailboxes/:mailboxId/emails/:id": "holder",
	"POST /api/v1/mailboxes/:mailboxId/emails/:id/move": "holder",
	"POST /api/v1/mailboxes/:mailboxId/emails/:id/spam-verdict": "holder",
	"POST /api/v1/mailboxes/:mailboxId/emails/:id/reply": "holder",
	"POST /api/v1/mailboxes/:mailboxId/emails/:id/forward": "holder",
	"POST /api/v1/mailboxes/:mailboxId/drafts": "holder",
	"PUT /api/v1/mailboxes/:mailboxId/drafts/:id": "holder",
	"GET /api/v1/mailboxes/:mailboxId/folders": "holder",
	"POST /api/v1/mailboxes/:mailboxId/folders": "holder",
	"PUT /api/v1/mailboxes/:mailboxId/folders/:id": "holder",
	"DELETE /api/v1/mailboxes/:mailboxId/folders/:id": "holder",
	"GET /api/v1/mailboxes/:mailboxId/contacts": "holder",
	"POST /api/v1/mailboxes/:mailboxId/contacts": "holder",
	"PUT /api/v1/mailboxes/:mailboxId/contacts/:id": "holder",
	"DELETE /api/v1/mailboxes/:mailboxId/contacts/:id": "holder",
	"GET /api/v1/mailboxes/:mailboxId/search": "holder",
	"GET /api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId":
		"holder",
	"GET /api/v1/mailboxes/:mailboxId/emails/:emailId/source": "holder",
	"PUT /api/v1/mailboxes/:mailboxId/emails/:emailId/source": "holder",
};

/** Every route the Worker registers, read from where it registers them. */
function registered(): string[] {
	return [
		...SOURCE.matchAll(/openapi\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g),
	].map(([, method, path]) => `${method.toUpperCase()} ${path}`);
}

/** Somebody else's mailbox: it exists, and the fixture person does not hold it. */
const THEIRS = "theirs@example.org";

const request = (route: string, signedIn: boolean) => {
	const [method, template] = route.split(" ");
	const path = template
		.replace(":mailboxId", encodeURIComponent(THEIRS))
		.replace(/:[A-Za-z]+/g, "x");
	const init: RequestInit = {
		method,
		headers: { "Content-Type": "application/json" },
		body: method === "GET" || method === "DELETE" ? undefined : "{}",
	};
	const url = `http://local.test${path}`;
	return signedIn ? authenticatedFetch(url, init) : SELF.fetch(url, init);
};

const routesThatAre = (...kinds: Access[]) =>
	Object.entries(TABLE)
		.filter(([, kind]) => kinds.includes(kind))
		.map(([route]) => route);

describe("the table of who may reach each route", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		// @ts-expect-error test binding
		await env.BUCKET.put(`mailboxes/${THEIRS}.json`, JSON.stringify({}));
		// @ts-expect-error test binding
		await env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")).giveMailboxToPerson(
			"someone-else",
			THEIRS,
		);
	});

	it("names every route the Worker registers, and no other", () => {
		const routes = registered();
		expect(routes.length).toBeGreaterThan(50);
		expect(routes.filter((route) => !(route in TABLE))).toEqual([]);
		expect(
			Object.keys(TABLE).filter((route) => !routes.includes(route)),
		).toEqual([]);
	});

	it("turns away everyone without a session, but from the public routes", async () => {
		const wrong: string[] = [];
		for (const route of routesThatAre("session", "holder", "root")) {
			const res = await request(route, false);
			if (res.status !== 401) wrong.push(`${route} -> ${res.status}`);
		}
		for (const route of routesThatAre("public")) {
			const res = await request(route, false);
			if (res.status === 401) wrong.push(`${route} -> 401 (public)`);
		}
		expect(wrong).toEqual([]);
	});

	it("turns away somebody who does not hold the mailbox", async () => {
		const wrong: string[] = [];
		for (const route of routesThatAre("holder")) {
			const res = await request(route, true);
			if (res.status !== 403) wrong.push(`${route} -> ${res.status}`);
		}
		expect(wrong).toEqual([]);
	});

	it("turns away everyone who is not root", async () => {
		const wrong: string[] = [];
		for (const route of routesThatAre("root")) {
			const res = await request(route, true);
			if (res.status !== 403) wrong.push(`${route} -> ${res.status}`);
		}
		expect(wrong).toEqual([]);
	});
});
