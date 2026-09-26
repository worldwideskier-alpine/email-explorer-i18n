import {
	createExecutionContext,
	env,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";
import { hashPassword } from "../../src/password";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Addresses have one spelling, a deleted mailbox stays deleted, and a few
 * routes answer for what they did rather than a 204 or a 500 regardless.
 */

const API = "http://local.test/api/v1";
// @ts-expect-error test binding
const bucket = (): R2Bucket => env.BUCKET;
// @ts-expect-error test binding
const auth = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
// @ts-expect-error test binding
const box = (id: string) => env.MAILBOX.get(env.MAILBOX.idFromName(id));

const json = (body: unknown, method = "POST"): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

const login = async (email: string, password = "password123") =>
	SELF.fetch(`${API}/auth/login`, json({ email, password }));

const as =
	(token: string) =>
	(url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});

async function twoPeople() {
	await SELF.fetch(
		`${API}/auth/register`,
		json({ email: "root@test.com", password: "password123" }),
	);
	const root = as((await (await login("root@test.com")).json<any>()).id);
	for (const email of ["first@test.com", "second@test.com"]) {
		const res = await root(
			`${API}/root/accounts`,
			json({ email, password: "password123", role: "admin" }),
		);
		expect(res.status).toBe(201);
	}
	const first = as((await (await login("first@test.com")).json<any>()).id);
	const second = as((await (await login("second@test.com")).json<any>()).id);
	return { root, first, second };
}

async function receive(raw: string, to: string) {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(raw);
	const rejections: string[] = [];
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(c) {
					c.enqueue(bytes);
					c.close();
				},
			}),
			rawSize: bytes.length,
			to,
			setReject: (reason: string) => rejections.push(reason),
		},
		env,
		createExecutionContext(),
	);
	return rejections;
}

describe("a mailbox address", () => {
	beforeEach(() => resetLegacyGrantMemo());

	/**
	 * A capitalised copy of somebody else's address was a new mailbox, and
	 * sending -- which compares without case -- then went out as theirs.
	 */
	it("is one mailbox however it is capitalised", async () => {
		const { first, second } = await twoPeople();
		expect(
			(
				await first(
					`${API}/mailboxes`,
					json({ email: "theirs@test.com", name: "t" }),
				)
			).status,
		).toBe(201);

		const copy = await second(
			`${API}/mailboxes`,
			json({ email: "THEIRS@Test.com", name: "x" }),
		);
		expect(copy.status).toBe(409);
		expect(await bucket().head("mailboxes/THEIRS@Test.com.json")).toBeNull();
	});

	it("is stored lowercased, so mail to it arrives", async () => {
		const { first } = await twoPeople();
		const made = await first(
			`${API}/mailboxes`,
			json({ email: "Info@Test.com", name: "i" }),
		);
		expect(made.status).toBe(201);
		expect((await made.json<{ id: string }>()).id).toBe("info@test.com");

		const rejected = await receive(
			"From: a@example.org\r\nTo: Info@Test.com\r\nSubject: hi\r\n\r\nbody",
			"info@test.com",
		);
		expect(rejected).toEqual([]);
		expect(await box("info@test.com").listAllEmailIds()).toHaveLength(1);
	});
});

describe("a sign-in address", () => {
	beforeEach(() => resetLegacyGrantMemo());

	it("signs in however it is capitalised, and is not registered twice", async () => {
		const { root } = await twoPeople();
		const made = await root(
			`${API}/root/accounts`,
			json({ email: "Alice@Test.com", password: "password123", role: "admin" }),
		);
		expect(made.status).toBe(201);

		expect((await login("alice@test.com")).status).toBe(200);
		expect((await login("ALICE@TEST.COM")).status).toBe(200);

		const again = await root(
			`${API}/root/accounts`,
			json({ email: "alice@TEST.com", password: "password123", role: "admin" }),
		);
		expect(again.status).toBe(400);
	});

	/**
	 * Rows from before were stored as typed; they still sign in, by either
	 * spelling.
	 */
	it("still finds an account stored with capitals", async () => {
		await SELF.fetch(
			`${API}/auth/register`,
			json({ email: "root@test.com", password: "password123" }),
		);
		await runInDurableObject(auth(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE users SET email = 'Root@Test.com' WHERE email = 'root@test.com'",
			);
		});
		expect((await login("root@test.com")).status).toBe(200);
		expect((await login("Root@Test.com")).status).toBe(200);
	});
});

describe("a deleted mailbox", () => {
	beforeEach(() => resetLegacyGrantMemo());

	async function deletedWithMail() {
		const { first } = await twoPeople();
		await first(
			`${API}/mailboxes`,
			json({ email: "gone@test.com", name: "g" }),
		);
		const raw = btoa(
			"From: spammer@example.org\r\nTo: gone@test.com\r\nSubject: s\r\n\r\nx",
		);
		const imported = await first(
			`${API}/admin/mailboxes/gone@test.com/import`,
			json({ folder: "inbox", rawEmailBase64: raw }),
		);
		const id = (await imported.json<{ id: string }>()).id;
		await first(
			`${API}/mailboxes/gone@test.com`,
			json({ settings: { deletionLocked: false } }, "PUT"),
		);
		expect(
			(await first(`${API}/mailboxes/gone@test.com`, { method: "DELETE" }))
				.status,
		).toBe(204);
		return { first, id, raw };
	}

	/**
	 * Its holder still holds it, and its Durable Object still has the mail;
	 * neither is a reason to act on it. A spam verdict used to write a fresh
	 * settings object and so bring the mailbox back from nothing.
	 */
	it("is not brought back by a spam verdict", async () => {
		const { first, id } = await deletedWithMail();
		const verdict = await first(
			`${API}/mailboxes/gone@test.com/emails/${id}/spam-verdict`,
			json({ verdict: "spam" }),
		);
		expect(verdict.status).toBe(404);
		expect(await bucket().head("mailboxes/gone@test.com.json")).toBeNull();
	});

	it("is not brought back by restoring into it", async () => {
		const { first, raw } = await deletedWithMail();
		const res = await first(
			`${API}/admin/mailboxes/gone@test.com/import`,
			json({ folder: "inbox", rawEmailBase64: raw }),
		);
		expect(res.status).toBe(404);
		expect(await bucket().head("mailboxes/gone@test.com.json")).toBeNull();
	});

	it("answers nothing about its mail until it is created again", async () => {
		const { first } = await deletedWithMail();
		expect((await first(`${API}/mailboxes/gone@test.com/emails`)).status).toBe(
			404,
		);
		expect(
			(
				await first(
					`${API}/mailboxes`,
					json({ email: "gone@test.com", name: "g" }),
				)
			).status,
		).toBe(201);
		expect((await first(`${API}/mailboxes/gone@test.com/emails`)).status).toBe(
			200,
		);
	});
});

describe("sender verdicts", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * The settings screen sends back everything it loaded. A verdict given
	 * after it was opened was undone by the next save of anything else.
	 */
	it("survive a save from a screen opened before them", async () => {
		const loaded = await (
			await authenticatedFetch(`${API}/mailboxes/${mailboxId}`)
		).json<{ settings: Record<string, unknown> }>();

		const raw = btoa(
			`From: pest@example.org\r\nTo: ${mailboxId}\r\nSubject: s\r\n\r\nx`,
		);
		const imported = await authenticatedFetch(
			`${API}/admin/mailboxes/${mailboxId}/import`,
			json({ folder: "inbox", rawEmailBase64: raw }),
		);
		const id = (await imported.json<{ id: string }>()).id;
		expect(
			(
				await authenticatedFetch(
					`${API}/mailboxes/${mailboxId}/emails/${id}/spam-verdict`,
					json({ verdict: "spam" }),
				)
			).status,
		).toBe(200);

		await authenticatedFetch(
			`${API}/mailboxes/${mailboxId}`,
			json({ settings: { ...loaded.settings, fromName: "Changed" } }, "PUT"),
		);

		const stored = await (
			await bucket().get(`mailboxes/${mailboxId}.json`)
		)?.json<any>();
		expect(stored.fromName).toBe("Changed");
		expect(stored.senderRules.block).toContain("pest@example.org");
	});
});

describe("a session past its expiry", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is refused everywhere and removed", async () => {
		await runInDurableObject(auth(), async (_i, state) => {
			state.storage.sql.exec(
				"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('stale', 'user1', ?, 0)",
				Date.now() - 1,
			);
		});
		const stale = as("stale");
		expect((await stale(`${API}/auth/me`)).status).toBe(401);
		expect((await stale(`${API}/mailboxes/${mailboxId}/emails`)).status).toBe(
			401,
		);
		const left = await runInDurableObject(auth(), async (_i, state) =>
			state.storage.sql
				.exec("SELECT id FROM sessions WHERE id = 'stale'")
				.toArray(),
		);
		expect(left).toEqual([]);
	});

	/** Ones never presented again are swept when anybody signs in. */
	it("is swept by the next sign-in, with its push subscription", async () => {
		const hash = await hashPassword("password123");
		await runInDurableObject(auth(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE users SET email = 'someone@test.com', password_hash = ? WHERE id = 'user1'",
				hash,
			);
			state.storage.sql.exec(
				"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('abandoned', 'user1', ?, 0)",
				Date.now() - 1,
			);
			state.storage.sql.exec(
				"INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, created_at) VALUES ('p', 'user1', 'abandoned', 'https://push.example.net/x', 'k', 'a', 0)",
			);
		});
		expect((await login("someone@test.com")).status).toBe(200);
		const left = await runInDurableObject(auth(), async (_i, state) => ({
			sessions: state.storage.sql
				.exec("SELECT id FROM sessions WHERE id = 'abandoned'")
				.toArray(),
			push: state.storage.sql
				.exec("SELECT id FROM push_subscriptions WHERE id = 'p'")
				.toArray(),
		}));
		expect(left).toEqual({ sessions: [], push: [] });
	});
});

describe("folders and contacts", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	const folders = `${API}/mailboxes/${mailboxId}/folders`;

	async function makeFolder(name: string) {
		const res = await authenticatedFetch(folders, json({ name }));
		expect(res.status).toBe(201);
		return (await res.json<{ id: string }>()).id;
	}

	/**
	 * The schema cascades a folder's deletion to its messages, leaving their
	 * originals and attachments in the bucket with nothing naming them.
	 */
	it("does not delete a folder with mail in it", async () => {
		const work = await makeFolder("Work");
		await authenticatedFetch(
			`${API}/admin/mailboxes/${mailboxId}/import`,
			json({
				folder: work,
				rawEmailBase64: btoa(
					`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: kept\r\n\r\nx`,
				),
			}),
		);
		const res = await authenticatedFetch(`${folders}/${work}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(409);
		expect(await box(mailboxId).listAllEmailIds()).toHaveLength(1);
	});

	it("still deletes an empty one", async () => {
		const empty = await makeFolder("Empty");
		expect(
			(await authenticatedFetch(`${folders}/${empty}`, { method: "DELETE" }))
				.status,
		).toBe(204);
	});

	it("answers 409 for a name that is taken, and leaves fixed folders alone", async () => {
		const a = await makeFolder("A");
		await makeFolder("B");
		expect(
			(await authenticatedFetch(`${folders}/${a}`, json({ name: "B" }, "PUT")))
				.status,
		).toBe(409);
		expect(
			(
				await authenticatedFetch(
					`${folders}/inbox`,
					json({ name: "Renamed" }, "PUT"),
				)
			).status,
		).toBe(404);
	});

	it("answers 409 for a contact that exists and 404 for one that does not", async () => {
		const contacts = `${API}/mailboxes/${mailboxId}/contacts`;
		expect(
			(
				await authenticatedFetch(
					contacts,
					json({ name: "A", email: "a@example.org" }),
				)
			).status,
		).toBe(201);
		expect(
			(
				await authenticatedFetch(
					contacts,
					json({ name: "A", email: "a@example.org" }),
				)
			).status,
		).toBe(409);
		expect(
			(await authenticatedFetch(`${contacts}/99999`, { method: "DELETE" }))
				.status,
		).toBe(404);
	});
});

describe("listing and search", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/** SQLite reads LIMIT -1 as no limit at all. */
	it("refuses an unbounded page", async () => {
		expect(
			(
				await authenticatedFetch(
					`${API}/mailboxes/${mailboxId}/emails?limit=-1`,
				)
			).status,
		).toBe(400);
	});

	it("looks for % and _ as typed", async () => {
		for (const subject of ["100% sure", "1000 things", "a_b", "axb"]) {
			await authenticatedFetch(
				`${API}/admin/mailboxes/${mailboxId}/import`,
				json({
					folder: "inbox",
					rawEmailBase64: btoa(
						`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: ${subject}\r\n\r\nx`,
					),
				}),
			);
		}
		const search = async (q: string) =>
			(
				await (
					await authenticatedFetch(
						`${API}/mailboxes/${mailboxId}/search?query=${encodeURIComponent(q)}`,
					)
				).json<{ subject: string }[]>()
			).map((e) => e.subject);
		expect(await search("100%")).toEqual(["100% sure"]);
		expect(await search("a_b")).toEqual(["a_b"]);
	});
});

describe("an attachment", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/** The row names the object; the path's email id has to be the row's. */
	it("is served only under the message it belongs to", async () => {
		const raw = [
			"From: a@example.org",
			`To: ${mailboxId}`,
			"Subject: with file",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="B"',
			"",
			"--B",
			"Content-Type: text/plain",
			"",
			"body",
			"--B",
			'Content-Type: text/plain; name="f.txt"',
			'Content-Disposition: attachment; filename="f.txt"',
			"",
			"file",
			"--B--",
			"",
		].join("\r\n");
		const imported = await authenticatedFetch(
			`${API}/admin/mailboxes/${mailboxId}/import`,
			json({ folder: "inbox", rawEmailBase64: btoa(raw) }),
		);
		const emailId = (await imported.json<{ id: string }>()).id;
		const email = await (
			await authenticatedFetch(
				`${API}/mailboxes/${mailboxId}/emails/${emailId}`,
			)
		).json<{ attachments: { id: string }[] }>();
		const attId = email.attachments[0].id;

		const base = `${API}/mailboxes/${mailboxId}/emails`;
		expect(
			(await authenticatedFetch(`${base}/${emailId}/attachments/${attId}`))
				.status,
		).toBe(200);
		expect(
			(
				await authenticatedFetch(
					`${base}/${crypto.randomUUID()}/attachments/${attId}`,
				)
			).status,
		).toBe(404);
	});
});
