import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";

/**
 * What one person holding a mailbox may never do to another's.
 *
 * Each case is a path measured letting a person reach mail that was not
 * theirs: registering an address somebody else had deleted and reading its
 * mail and archives, reading or deleting another mailbox's original message
 * by its id, and sending as an address that was not the mailbox in the path.
 */

const login = async (email: string, password = "password123") => {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return (await res.json<{ id: string }>()).id;
};

const as =
	(token: string) =>
	(url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});

const json = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

const API = "http://local.test/api/v1";
const THEIRS = "theirs@test.com";
const MINE = "mine@test.com";
// @ts-expect-error test binding
const bucket = (): R2Bucket => env.BUCKET;

/** Two people; the first holds THEIRS, the second holds MINE. */
async function setUpTwoPeople() {
	await SELF.fetch(
		`${API}/auth/register`,
		json({ email: "root@test.com", password: "password123" }),
	);
	const root = as(await login("root@test.com"));
	for (const email of ["first@test.com", "second@test.com"]) {
		const created = await root(
			`${API}/root/accounts`,
			json({ email, password: "password123", role: "admin" }),
		);
		expect(created.status).toBe(201);
	}
	const first = as(await login("first@test.com"));
	const second = as(await login("second@test.com"));
	expect(
		(await first(`${API}/mailboxes`, json({ email: THEIRS, name: "t" })))
			.status,
	).toBe(201);
	expect(
		(await second(`${API}/mailboxes`, json({ email: MINE, name: "m" }))).status,
	).toBe(201);
	return { first, second };
}

type Fetch = ReturnType<typeof as>;

async function importInto(who: Fetch, mailbox: string, subject: string) {
	const raw = [
		"From: sender@example.org",
		`To: ${mailbox}`,
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		`${subject} body`,
		"",
	].join("\r\n");
	const res = await who(
		`${API}/admin/mailboxes/${mailbox}/import`,
		json({ folder: "inbox", rawEmailBase64: btoa(raw) }),
	);
	expect(res.status).toBe(201);
	return (await res.json<{ id: string }>()).id;
}

async function unlockAndDelete(who: Fetch, mailbox: string, purge: boolean) {
	const unlocked = await who(`${API}/mailboxes/${mailbox}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ settings: { deletionLocked: false } }),
	});
	expect(unlocked.status).toBe(200);
	const deleted = await who(
		`${API}/mailboxes/${mailbox}${purge ? "?purge=true" : ""}`,
		{ method: "DELETE" },
	);
	expect(deleted.status).toBe(204);
}

const archiveKey = (mailbox: string, name: string) =>
	`backups/${encodeURIComponent(mailbox)}/${name}`;

describe("an address that was deleted", () => {
	let first: Fetch;
	let second: Fetch;
	beforeEach(async () => {
		resetLegacyGrantMemo();
		({ first, second } = await setUpTwoPeople());
	});

	it("is not given to somebody else, and its mail stays its holder's", async () => {
		await importInto(first, THEIRS, "private");
		await unlockAndDelete(first, THEIRS, false);

		expect(
			(await second(`${API}/mailboxes`, json({ email: THEIRS, name: "x" })))
				.status,
		).toBe(409);
		expect((await second(`${API}/mailboxes/${THEIRS}/emails`)).status).toBe(
			403,
		);
	});

	it("comes back, mail and all, to the person who holds it", async () => {
		await importInto(first, THEIRS, "private");
		await unlockAndDelete(first, THEIRS, false);

		expect(
			(await first(`${API}/mailboxes`, json({ email: THEIRS, name: "t" })))
				.status,
		).toBe(201);
		const listed = await first(`${API}/mailboxes/${THEIRS}/emails`);
		expect(
			(await listed.json<{ subject: string }[]>()).map((e) => e.subject),
		).toEqual(["private"]);
	});

	/**
	 * Purged: the mail is gone, the archives are kept on purpose (they are how
	 * mail destroyed from a stolen session comes back), and they stay the
	 * holder's -- nobody else can register the address and be served them.
	 */
	it("keeps its archives for its holder, and for nobody else, after a purge", async () => {
		await importInto(first, THEIRS, "private");
		const name = "2026-09-01T00-00-00-000Z.mbox";
		await bucket().put(
			archiveKey(THEIRS, name),
			"From MAILER-DAEMON\nSubject: private\n\n",
		);
		await unlockAndDelete(first, THEIRS, true);

		expect(await bucket().head(archiveKey(THEIRS, name))).not.toBeNull();
		expect(
			(await second(`${API}/mailboxes`, json({ email: THEIRS, name: "x" })))
				.status,
		).toBe(409);
		expect(
			(await second(`${API}/mailboxes/${THEIRS}/backups/${name}`)).status,
		).toBe(403);

		expect(
			(await first(`${API}/mailboxes`, json({ email: THEIRS, name: "t" })))
				.status,
		).toBe(201);
		expect(
			(await first(`${API}/mailboxes/${THEIRS}/emails`).then((r) =>
				r.json(),
			)) as unknown[],
		).toEqual([]);
		const download = await first(`${API}/mailboxes/${THEIRS}/backups/${name}`);
		expect(download.status).toBe(200);
		expect(await download.text()).toContain("Subject: private");
	});

	/**
	 * The settings come back with it, so recreating is no way round the rule
	 * that the backup count may only rise, nor a way to write a run history.
	 */
	it("comes back with its settings, which a recreate cannot lower or forge", async () => {
		const set = await first(`${API}/mailboxes/${THEIRS}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: {
					autoBackup: { enabled: true, frequency: "daily", keep: 5 },
				},
			}),
		});
		expect(set.status).toBe(200);
		await unlockAndDelete(first, THEIRS, false);

		const recreated = await first(
			`${API}/mailboxes`,
			json({
				email: THEIRS,
				name: "t",
				settings: {
					autoBackup: {
						enabled: true,
						keep: 1,
						lastRunAt: "2099-01-01T00:00:00.000Z",
					},
				},
			}),
		);
		expect(recreated.status).toBe(201);
		const stored = await (
			await bucket().get(`mailboxes/${THEIRS}.json`)
		)?.json<any>();
		expect(stored.autoBackup.keep).toBe(5);
		expect(stored.autoBackup.lastRunAt).toBeUndefined();
		expect(await bucket().head(`mailboxes-deleted/${THEIRS}.json`)).toBeNull();
	});

	it("is given to nobody when nobody holds it and archives remain", async () => {
		await bucket().put(
			archiveKey("orphan@test.com", "2026-09-01T00-00-00-000Z.mbox"),
			"x",
		);
		expect(
			(
				await second(
					`${API}/mailboxes`,
					json({ email: "orphan@test.com", name: "o" }),
				)
			).status,
		).toBe(409);
	});
});

describe("an original message", () => {
	let first: Fetch;
	let second: Fetch;
	beforeEach(async () => {
		resetLegacyGrantMemo();
		({ first, second } = await setUpTwoPeople());
	});

	it("is not read or deleted through another mailbox by its id", async () => {
		const id = await importInto(first, THEIRS, "private");

		expect(
			(await second(`${API}/mailboxes/${MINE}/emails/${id}/source`)).status,
		).toBe(404);
		expect(
			(
				await second(`${API}/mailboxes/${MINE}/emails/${id}`, {
					method: "DELETE",
				})
			).status,
		).toBe(404);

		const own = await first(`${API}/mailboxes/${THEIRS}/emails/${id}/source`);
		expect(own.status).toBe(200);
		expect(await own.text()).toContain("Subject: private");
	});
});

describe("mail sent through a mailbox", () => {
	let second: Fetch;
	let replyTo: string;
	beforeEach(async () => {
		resetLegacyGrantMemo();
		({ second } = await setUpTwoPeople());
		replyTo = await importInto(second, MINE, "question");
	});

	const body = (from: string) => ({
		to: ["someone@example.org"],
		from,
		subject: "hello",
		text: "hello",
	});

	for (const [route, path] of [
		["send", () => `${API}/mailboxes/${MINE}/emails`],
		["reply", () => `${API}/mailboxes/${MINE}/emails/${replyTo}/reply`],
		["forward", () => `${API}/mailboxes/${MINE}/emails/${replyTo}/forward`],
	] as const) {
		it(`names the mailbox as its sender: ${route}`, async () => {
			for (const from of ["root@test.com", THEIRS]) {
				expect((await second(path(), json(body(from)))).status, from).toBe(403);
			}
			expect((await second(path(), json(body("Mine@Test.com")))).status).toBe(
				201,
			);
		});
	}
});

describe("a new address asked for twice at once", () => {
	beforeEach(() => resetLegacyGrantMemo());

	/** The checks come several awaits before the grant; the claim does not. */
	it("goes to one person", async () => {
		const { first, second } = await setUpTwoPeople();
		const [a, b] = await Promise.all([
			first(
				`${API}/mailboxes`,
				json({ email: "contested@test.com", name: "a" }),
			),
			second(
				`${API}/mailboxes`,
				json({ email: "contested@test.com", name: "b" }),
			),
		]);
		expect([a.status, b.status].sort()).toEqual([201, 409]);

		// @ts-expect-error test binding
		const authStub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		const holders = await authStub.getUserIdsForMailbox("contested@test.com");
		expect(holders).toHaveLength(1);
	});
});
