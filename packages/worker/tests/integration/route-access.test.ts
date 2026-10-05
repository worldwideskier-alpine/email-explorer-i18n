import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import SOURCE from "../../src/index.ts?raw";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	personId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Who may reach each route, as one table.
 *
 * Every other test asks about the route it is about. This asks every route
 * the same three questions -- without a session, as somebody who does not
 * hold the mailbox, as somebody who is not root -- so a route added without
 * its gate fails here whatever else it does. And the table has to name every
 * route the Worker registers: a new one is classified before this passes.
 *
 * Each question is asked from the other side too: the holder reaches every
 * route of their own mailbox, root every root route, a session every session
 * route. A gate that refused everyone would pass the refusals alone.
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
	"GET /api/v1/root/maintenance/history": "root",
	"POST /api/v1/root/accounts": "root",
	"POST /api/v1/root/accounts/:userId/password": "root",
	"POST /api/v1/root/accounts/:personId/lock": "root",
	"DELETE /api/v1/root/accounts/:personId": "root",
	"GET /api/v1/root/attachments": "root",
	"POST /api/v1/root/attachments/repair": "root",
	"POST /api/v1/root/attachments/purge": "root",
	"GET /api/v1/root/settings/account-recovery": "root",
	"PUT /api/v1/root/settings/account-recovery": "root",
	"GET /api/v1/root/settings/turnstile": "root",
	"PUT /api/v1/root/settings/turnstile": "root",
	"DELETE /api/v1/root/settings/turnstile": "root",
	"POST /api/v1/root/settings/turnstile/verify": "root",

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

const request = (route: string, signedIn: boolean, mailbox = THEIRS) => {
	const [method, template] = route.split(" ");
	const path = template
		.replace(":mailboxId", encodeURIComponent(mailbox))
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
		await env.BUCKET.put(`mailboxes/${THEIRS}.json`, JSON.stringify({}));
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

/**
 * The same table from the side that is let in. What a route answers past its
 * gate depends on what it was sent -- ids here are made up, bodies empty --
 * so this asks only that the gate itself did not refuse: never 401, never
 * 403. A route that is refused here refuses the people it exists for.
 */
describe("the table, from the side that is let in", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	const refused = async (routes: string[], mailbox?: string) => {
		const wrong: string[] = [];
		for (const route of routes) {
			const res = await request(route, true, mailbox);
			if (res.status === 401 || res.status === 403) {
				wrong.push(`${route} -> ${res.status}`);
			}
		}
		return wrong;
	};

	it("lets the holder reach every route of their own mailbox", async () => {
		expect(await refused(routesThatAre("holder"), mailboxId)).toEqual([]);
	});

	it("lets a session reach every route that needs only a session", async () => {
		// Each run of these may end the session (logout, a password change),
		// so each is asked on a session of its own.
		const wrong: string[] = [];
		for (const route of routesThatAre("session")) {
			await testAuthBeforeAll();
			wrong.push(...(await refused([route])));
		}
		expect(wrong).toEqual([]);
	});

	it("lets root reach every root route", async () => {
		await runInDurableObject(
			env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")),
			async (_instance, state) => {
				state.storage.sql.exec(
					"UPDATE app_roles SET root_person_id = ? WHERE id = 1",
					personId,
				);
			},
		);
		expect(await refused(routesThatAre("root"))).toEqual([]);
	});
});
