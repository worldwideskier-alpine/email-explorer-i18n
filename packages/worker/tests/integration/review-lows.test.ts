import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { newestArchiveAt } from "../../src/spam-purge-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Smaller things a review found, each able to fail.
 */

const API = "http://local.test/api/v1";
const box = `${API}/mailboxes/${encodeURIComponent(mailboxId)}`;

async function importRaw(raw: string, extra: Record<string, unknown> = {}) {
	const res = await authenticatedFetch(
		`${API}/admin/mailboxes/${encodeURIComponent(mailboxId)}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				folder: "inbox",
				rawEmailBase64: btoa(raw),
				...extra,
			}),
		},
	);
	expect(res.status).toBe(201);
	return (await res.json<{ id: string }>()).id;
}

const withFixture = () =>
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

describe("a date given to the import", () => {
	withFixture();

	it("cannot split a message in the archive", async () => {
		await importRaw("From: a@example.org\r\nSubject: dated\r\n\r\nx", {
			date: "not a date\r\nX-Spliced: yes",
		});
		const archive = await (await authenticatedFetch(`${box}/export`)).text();
		expect(archive).not.toMatch(/^X-Spliced:/m);
		expect(archive).toContain(
			"X-Email-Explorer-Date: not a date X-Spliced: yes",
		);
	});
});

describe("the newest archive", () => {
	withFixture();

	it("is found among objects that are not archives", async () => {
		const prefix = `backups/${encodeURIComponent(mailboxId)}/`;
		await env.BUCKET.put(`${prefix}2026-09-01T02-00-00-000Z.mbox`, "a");
		// Sorts above every stamp, and is not one.
		await env.BUCKET.put(`${prefix}notes.mbox`, "hand-made");
		expect(await newestArchiveAt(env as never, mailboxId)).toBe(
			Date.parse("2026-09-01T02:00:00.000Z"),
		);
	});
});

describe("an attachment", () => {
	withFixture();

	const RAW = [
		"From: a@example.org",
		"Subject: with a file",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		"Content-Type: text/plain",
		"",
		"see attached",
		"--b",
		"Content-Type: text/plain",
		'Content-Disposition: attachment; filename="a.txt"',
		"",
		"alert(1)",
		"--b--",
		"",
	].join("\r\n");

	async function attachmentPath() {
		const id = await importRaw(RAW);
		const email = await (await authenticatedFetch(`${box}/emails/${id}`)).json<{
			attachments: { id: string }[];
		}>();
		return `${box}/emails/${id}/attachments/${email.attachments[0].id}`;
	}

	it("is served with its type taken as given", async () => {
		const res = await authenticatedFetch(await attachmentPath());
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("is not loaded by a page as a script or a stylesheet", async () => {
		const path = await attachmentPath();
		for (const dest of ["script", "style", "worker"]) {
			const res = await authenticatedFetch(path, {
				headers: { "Sec-Fetch-Dest": dest },
			});
			expect(res.status, dest).toBe(403);
		}
		const picture = await authenticatedFetch(path, {
			headers: { "Sec-Fetch-Dest": "image" },
		});
		expect(picture.status).toBe(200);
	});
});

describe("a contact updated with one field", () => {
	withFixture();

	it("keeps the other", async () => {
		const made = await authenticatedFetch(`${box}/contacts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Somebody", email: "one@example.org" }),
		});
		const { id } = await made.json<{ id: number }>();
		const updated = await authenticatedFetch(`${box}/contacts/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "two@example.org" }),
		});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({
			name: "Somebody",
			email: "two@example.org",
		});
	});
});

// No fixture: root is whoever registers first, as on a new deployment.
describe("a person root makes", () => {
	it("is answered in the shape the account list has", async () => {
		await SELF.fetch(`${API}/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "op@example.com",
				password: "password123",
			}),
		});
		const root = (
			await (
				await SELF.fetch(`${API}/auth/login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "op@example.com",
						password: "password123",
					}),
				})
			).json<{ id: string }>()
		).id;
		const as = (path: string, init: RequestInit = {}) =>
			SELF.fetch(`${API}${path}`, {
				...init,
				headers: {
					...init.headers,
					"Content-Type": "application/json",
					Authorization: `Bearer ${root}`,
				},
			});
		const made = await as("/root/accounts", {
			method: "POST",
			body: JSON.stringify({
				email: "new@example.com",
				password: "password123",
				role: "admin",
			}),
		});
		expect(made.status).toBe(201);
		const person = await made.json<Record<string, unknown>>();
		const listed = await (await as("/root/accounts")).json<
			Record<string, unknown>[]
		>();
		expect(listed).toContainEqual(person);
		expect(Object.keys(person).sort()).toEqual([
			"createdAt",
			"deletionLocked",
			"emails",
			"logins",
			"personId",
			"role",
		]);

		// A spare for root is root's person, every address of it.
		const spare = await as("/root/accounts", {
			method: "POST",
			body: JSON.stringify({
				email: "op-spare@example.com",
				password: "password123",
				role: "root",
				currentPassword: "password123",
			}),
		});
		expect(spare.status).toBe(201);
		expect(
			((await spare.json<{ emails: string[] }>()).emails ?? []).sort(),
		).toEqual(["op-spare@example.com", "op@example.com"]);
	});
});

/**
 * Which version of the Worker answered, for the deploy's last step to
 * compare with the one it published.
 */
describe("the public settings", () => {
	it("say which version is answering", async () => {
		const settings = await (await SELF.fetch(`${API}/settings`)).json<{
			version: unknown;
		}>();
		expect(settings).toHaveProperty("version");
		expect(
			settings.version === null || typeof settings.version === "string",
		).toBe(true);
	});
});
