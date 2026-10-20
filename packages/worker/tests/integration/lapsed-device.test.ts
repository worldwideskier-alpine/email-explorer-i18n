import {
	createExecutionContext,
	env,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxDO } from "../../src/durableObject";
import { authMigrations } from "../../src/durableObject/migrations";
import { DEFAULT_MAIL_LOCALE } from "../../src/mail-templates";
import { hashPassword } from "../../src/password";
import { OPEN_THE_APP } from "../../src/push-notice";
import { notifyNewEmail } from "../../src/push-notify";
import {
	arrivedAt,
	type Browser,
	browserSubscription,
	keptFor,
	PUSH_ORIGIN,
	received,
} from "./push-reader";
import { enableAccountRecovery } from "./utils";

/**
 * A device whose session has run out.
 *
 * A session ends thirty days after sign-in and nothing renews it. A phone
 * used only to show notifications never signs in on its own, so on the
 * thirtieth day the Worker stopped telling it anything -- by design, since
 * the notification carries the sender and subject -- and nothing said so:
 * the switch on the phone read "on", and nothing was logged. Its
 * subscription was deleted besides, the moment it or anything else touched
 * the session (a request made with the old token, any sign-in anywhere).
 *
 * Now its session is kept for LAPSED_WINDOW_MS after it runs out, signing in
 * nobody, and new mail tells the device -- at most once a day, with nothing
 * of the message in it -- to open the app.
 */

const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-staple";
const MAILBOX = "inbox@example.com";
const LABEL = "Front Desk";
const SENDER = "sender@example.net";
const API = "http://local.test/api/v1";
const DAY = 24 * 60 * 60 * 1000;
/** How long a lapsed session is kept: written out, not imported, so a
 * change to the constant is a change this test notices -- either way, since
 * each edge is asked from both sides. */
const KEPT = 30 * DAY;

const authStub = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

/**
 * A call to the auth object made inside it rather than over RPC. A statement
 * that fails there over RPC failed its test and then left the runner hanging,
 * the failure reported as uncaught in the object, until the job's timeout.
 */
const inAuth = <T>(call: (auth: MailboxDO) => Promise<T>) =>
	runInDurableObject(authStub(), (instance: MailboxDO) => call(instance));
const mailboxStub = () => env.MAILBOX.get(env.MAILBOX.idFromName(MAILBOX));

/** The owner, one login, holding MAILBOX, with these sessions. */
async function seed(sessions: Record<string, number>) {
	await enableAccountRecovery();
	const hash = await hashPassword(PASSWORD);
	await runInDurableObject(authStub(), async (_i, state) => {
		const now = Date.now();
		state.storage.sql.exec(
			"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES ('owner', ?, ?, 0, 'person-owner', ?, ?)",
			EMAIL,
			hash,
			now,
			now,
		);
		for (const [id, expiresAt] of Object.entries(sessions)) {
			state.storage.sql.exec(
				"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'owner', ?, ?)",
				id,
				expiresAt,
				now,
			);
		}
	});
	await env.BUCKET.put(
		`mailboxes/${MAILBOX}.json`,
		JSON.stringify({ fromName: LABEL }),
	);
	await authStub().giveMailboxToPerson("person-owner", MAILBOX);
}

const as = (token: string, path: string, body?: unknown, method = "POST") =>
	SELF.fetch(`${API}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

/** A device, subscribed under `session` at a path of its own. */
async function device(session: string, locale?: unknown) {
	const browser = await browserSubscription();
	const path = `/device/${crypto.randomUUID()}`;
	const res = await as(session, "/push/subscribe", {
		endpoint: `${PUSH_ORIGIN}${path}`,
		keys: browser.keys,
		...(locale === undefined ? {} : { locale }),
	});
	expect(res.status).toBe(200);
	return { browser, path };
}

async function expire(session: string, by = 1) {
	await runInDurableObject(authStub(), async (_i, state) => {
		state.storage.sql.exec(
			"UPDATE sessions SET expires_at = ? WHERE id = ?",
			Date.now() - by,
			session,
		);
	});
}

/** Delivers a message to MAILBOX the way Email Routing does. */
async function deliver(subject: string) {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(
		[
			`From: ${SENDER}`,
			`To: ${MAILBOX}`,
			`Subject: ${subject}`,
			`Message-ID: <${crypto.randomUUID()}@example.net>`,
			"",
			"body",
		].join("\r\n"),
	);
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(c) {
					c.enqueue(bytes);
					c.close();
				},
			}),
			rawSize: bytes.length,
			to: MAILBOX,
			setReject: () => {},
		},
		env,
		createExecutionContext(),
	);
}

async function messages() {
	return runInDurableObject(mailboxStub(), async (_i, state) =>
		state.storage.sql
			.exec("SELECT id, subject, notified FROM emails ORDER BY subject")
			.toArray()
			.map((row) => ({
				id: String(row.id),
				subject: String(row.subject),
				notified: Number(row.notified),
			})),
	);
}

async function pushRows() {
	return runInDurableObject(authStub(), async (_i, state) =>
		state.storage.sql
			.exec(
				"SELECT session_id, locale, notice_at FROM push_subscriptions ORDER BY session_id",
			)
			.toArray(),
	);
}

const login = () =>
	SELF.fetch(`${API}/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
	});

/**
 * What a device that never said its language is told: the package's default
 * and English, one line each -- or English alone, were that the default.
 */
const UNSAID_LINES =
	DEFAULT_MAIL_LOCALE === "en"
		? [OPEN_THE_APP.en]
		: [OPEN_THE_APP[DEFAULT_MAIL_LOCALE], OPEN_THE_APP.en];
const UNSAID = UNSAID_LINES.join("\n");

/** That `pushes` say nothing of the message, the mailbox or the sender. */
function sayNothingOf(pushes: Record<string, string>[], subject: string) {
	for (const push of pushes) {
		const text = JSON.stringify(push);
		for (const secret of [subject, SENDER, MAILBOX, LABEL, "/mailbox/"]) {
			expect(text).not.toContain(secret);
		}
	}
}

async function read(browser: Browser, path: string) {
	return received(browser, path);
}

describe("a device whose session has run out", () => {
	beforeEach(async () => {
		await seed({ phone: Date.now() + DAY });
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is told to open the app, and nothing of the message", async () => {
		const { browser, path } = await device("phone");
		await expire("phone");

		await deliver("Quarterly figures");

		const pushes = await read(browser, path);
		expect(pushes).toEqual([
			{ title: "Email Explorer", body: UNSAID, url: "/login", tag: "open-app" },
		]);
		sayNothingOf(pushes, "Quarterly figures");
		const [{ id }] = await messages();
		expect(JSON.stringify(pushes)).not.toContain(id);
	});

	/**
	 * The sequence that silenced a phone: its session ran out, and then any
	 * sign-in anywhere swept the session and the subscription with it.
	 */
	it("is still told after another device signs in", async () => {
		const { browser, path } = await device("phone");
		await expire("phone");
		expect((await login()).status).toBe(200);

		await deliver("After a sign-in elsewhere");
		expect(await read(browser, path)).toEqual([
			{ title: "Email Explorer", body: UNSAID, url: "/login", tag: "open-app" },
		]);
	});

	/**
	 * And this one: the phone opened, its first request made with the
	 * expired token -- answered 401, as it should be -- and that request
	 * deleted the session and its subscription.
	 */
	it("is still told after its expired token was presented", async () => {
		const { browser, path } = await device("phone");
		await expire("phone");
		const me = await SELF.fetch(`${API}/auth/me`, {
			headers: { Authorization: "Bearer phone" },
		});
		expect(me.status).toBe(401);

		await deliver("After the token was presented");
		expect(await read(browser, path)).toHaveLength(1);
	});

	/**
	 * The window's other edge: a minute short of it, after the two things
	 * that used to end it -- its token presented, a sign-in elsewhere. With
	 * only the far edge asked, a window cut to a day or two minutes passed
	 * every test, and a phone fell silent that much sooner.
	 */
	it("is still told a minute before it is past keeping", async () => {
		const { browser, path } = await device("phone");
		await expire("phone", KEPT - 60_000);
		const me = await SELF.fetch(`${API}/auth/me`, {
			headers: { Authorization: "Bearer phone" },
		});
		expect(me.status).toBe(401);
		expect((await login()).status).toBe(200);

		await deliver("A minute short of the month");
		expect(await read(browser, path)).toEqual([
			{ title: "Email Explorer", body: UNSAID, url: "/login", tag: "open-app" },
		]);
	});

	/**
	 * A reminder stands for the device's day, and a push service drops what
	 * it took once the time it was given runs out. Kept an hour, as a
	 * message is, a phone switched off for the night when the day's reminder
	 * went out was shown nothing that day -- and the day counted as told.
	 */
	it("is sent its reminder to keep for the day, while a message is kept an hour", async () => {
		await seedLiveSession("laptop");
		const phone = await device("phone");
		const laptop = await device("laptop");
		await expire("phone");

		await deliver("Kept");
		expect(await keptFor(phone.path)).toEqual([23 * 60 * 60]);
		expect(await keptFor(laptop.path)).toEqual([60 * 60]);
	});

	/**
	 * Not announced: only a device that showed the message is sent its
	 * dismissal, and a lapsed one did not.
	 */
	it("leaves the message unannounced, so reading it sends that device nothing", async () => {
		const { path } = await device("phone");
		await expire("phone");
		await deliver("Unannounced");
		expect(await arrivedAt(path)).toBe(1);

		const [message] = await messages();
		expect(message.notified).toBe(0);
		await seedLiveSession("reader");
		const res = await as(
			"reader",
			`/mailboxes/${MAILBOX}/emails/${message.id}`,
			{ read: true },
			"PUT",
		);
		expect(res.status).toBe(200);
		expect(await arrivedAt(path)).toBe(1);
	});

	/**
	 * Both edges of the day: a minute short of it still counts as the same
	 * day, and the day itself does not.
	 */
	it("is told once a day, however much mail comes", async () => {
		const { path } = await device("phone");
		await expire("phone");
		await deliver("First");
		await deliver("Second");
		expect(await arrivedAt(path)).toBe(1);

		const toldEarlierBy = (ms: number) =>
			runInDurableObject(authStub(), async (_i, state) => {
				state.storage.sql.exec(
					"UPDATE push_subscriptions SET notice_at = notice_at - ?",
					ms,
				);
			});
		await toldEarlierBy(DAY - 60_000);
		await deliver("Third, a minute short of a day later");
		expect(await arrivedAt(path)).toBe(1);

		await toldEarlierBy(60_000);
		await deliver("Fourth, a day later");
		expect(await arrivedAt(path)).toBe(2);
	});

	/**
	 * The day's notice is marked before it is sent, so two messages at once
	 * send one. A push service that did not take it gives the day back: the
	 * device this is for was otherwise told nothing until the next day.
	 */
	it("is told with the next message when its push service did not take the notice", async () => {
		const logged: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		const browser = await browserSubscription();
		const res = await as("phone", "/push/subscribe", {
			endpoint: `https://push-busy.example.test/${crypto.randomUUID()}`,
			keys: browser.keys,
		});
		expect(res.status).toBe(200);
		await expire("phone");

		await deliver("Refused");
		expect((await pushRows())[0].notice_at).toBeNull();
		await deliver("Tried again");
		const refusals = logged.filter((line) =>
			line.includes("push-busy.example.test"),
		);
		expect(refusals).toHaveLength(2);
	});

	/**
	 * Given back only where the mark is still that send's own. A later send
	 * that marked the device again keeps its mark when the earlier one's
	 * refusal comes back; cleared, the device was told twice in a day.
	 */
	it("keeps a later notice's mark when an earlier one's refusal comes back", async () => {
		const { path } = await device("phone");
		await expire("phone");
		const holders = await authStub().getUserIdsForMailbox(MAILBOX);
		const earlier = await inAuth((auth) => auth.pushTargetsForNewMail(holders));
		expect(earlier.lapsed).toHaveLength(1);

		// A day on, the next message marks the device again...
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE push_subscriptions SET notice_at = notice_at - ?",
				DAY,
			);
		});
		while (Date.now() <= earlier.noticeAt) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const later = await inAuth((auth) => auth.pushTargetsForNewMail(holders));
		expect(later.lapsed).toHaveLength(1);
		expect(later.noticeAt).toBeGreaterThan(earlier.noticeAt);

		// ...and only then does the earlier send's refusal come back.
		await inAuth((auth) =>
			auth.lapsedNoticesNotSent(
				earlier.lapsed.map((target) => target.endpoint),
				earlier.noticeAt,
			),
		);
		expect((await pushRows())[0].notice_at).toBe(later.noticeAt);
		await deliver("The same day as the later notice");
		expect(await arrivedAt(path)).toBe(0);
	});

	/**
	 * Giving the day back is a call to the auth object, and a call can fail
	 * -- the object reset by a deploy, a connection lost. A live device that
	 * showed the message showed it all the same: answered "not announced",
	 * the message was never dismissed there once it was read.
	 */
	it("leaves a message a live device showed announced when the day cannot be given back", async () => {
		const logged: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		const giveBack = vi
			.spyOn(MailboxDO.prototype, "lapsedNoticesNotSent")
			.mockRejectedValue(new Error("Network connection lost: GIVE-BACK-TEXT"));
		await seedLiveSession("laptop");
		const laptop = await device("laptop");
		const browser = await browserSubscription();
		const res = await as("phone", "/push/subscribe", {
			endpoint: `https://push-busy.example.test/${crypto.randomUUID()}`,
			keys: browser.keys,
		});
		expect(res.status).toBe(200);
		await expire("phone");

		await deliver("Shown on the laptop");
		expect(giveBack).toHaveBeenCalledTimes(1);
		expect(await arrivedAt(laptop.path)).toBe(1);
		const [message] = await messages();
		expect(message.notified).toBe(1);
		expect(logged).toContain("Push notice give-back failed: Error");
		expect(logged.join("\n")).not.toContain("GIVE-BACK-TEXT");
	});

	it("is told the message again once it is back, and starts the day afresh", async () => {
		const { browser, path } = await device("phone");
		await expire("phone");
		await deliver("While away");

		// The phone signs in and its browser hands its subscription over.
		const session = await (await login()).json<{ id: string }>();
		const res = await as(session.id, "/push/subscribe", {
			endpoint: `${PUSH_ORIGIN}${path}`,
			keys: browser.keys,
		});
		expect(res.status).toBe(200);
		expect((await pushRows())[0].notice_at).toBeNull();

		await deliver("Back again");
		const pushes = await read(browser, path);
		expect(pushes).toHaveLength(2);
		expect(pushes[1].title).toBe(`[${LABEL}] ${SENDER}`);
		expect(pushes[1].body).toBe("Back again");
	});

	it("is not told once it is past keeping", async () => {
		const { path } = await device("phone");
		await expire("phone", KEPT + 1);
		await deliver("Too late");
		expect(await arrivedAt(path)).toBe(0);
	});
});

/** Another session of the owner's, live, for a request of its own. */
async function seedLiveSession(id: string) {
	await runInDurableObject(authStub(), async (_i, state) => {
		state.storage.sql.exec(
			"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'owner', ?, ?)",
			id,
			Date.now() + DAY,
			Date.now(),
		);
	});
}

/**
 * Everything that ends a login's sessions on purpose ends the lapsed ones
 * too, and their devices hear nothing more: a password is changed, or a
 * login deleted, to get rid of whoever holds a device.
 */
describe("ending sessions on purpose", () => {
	beforeEach(async () => {
		await seed({ phone: Date.now() + DAY, laptop: Date.now() + DAY });
	});

	const lapsedRows = async () =>
		(await pushRows()).filter((row) => row.session_id === "phone");

	async function phoneLapsed() {
		await device("phone");
		await expire("phone", 60_000);
		expect(await lapsedRows()).toHaveLength(1);
	}

	it("a password change", async () => {
		await phoneLapsed();
		const res = await as("laptop", "/auth/change-password", {
			currentPassword: PASSWORD,
			newPassword: "a-brand-new-password",
		});
		expect(res.status).toBe(200);
		expect(await lapsedRows()).toEqual([]);
	});

	it("a reset", async () => {
		await phoneLapsed();
		const stamp = (await authStub().emailChangeStamp("owner")) as string;
		const token = crypto.randomUUID();
		await env.BUCKET.put(
			`recovery-tokens/${token}.json`,
			JSON.stringify({
				userId: "owner",
				email: EMAIL,
				stamp,
				expiresAt: Date.now() + 60_000,
			}),
		);
		const res = await SELF.fetch(`${API}/auth/reset-password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token, newPassword: "a-brand-new-password" }),
		});
		expect(res.status).toBe(200);
		expect(await lapsedRows()).toEqual([]);
	});

	it("root setting the password", async () => {
		await phoneLapsed();
		expect(await authStub().setUserPassword("owner", "set-by-root-1")).toBe(
			"ok",
		);
		expect(await lapsedRows()).toEqual([]);
	});

	it("deleting the login", async () => {
		await phoneLapsed();
		await authStub().register(
			"spare@example.com",
			PASSWORD,
			false,
			"person-owner",
		);
		expect(await authStub().deleteLogin("owner")).toBe("ok");
		expect(await lapsedRows()).toEqual([]);
	});

	it("deleting the person", async () => {
		await phoneLapsed();
		expect((await authStub().deletePerson("person-owner")).status).toBe("ok");
		expect(await lapsedRows()).toEqual([]);
	});
});

/**
 * Signing out after the session ran out: from a browser that was offline
 * when its person pressed the button, or behind an Access sign-in that had
 * lapsed. It used to be refused for want of the session it ended, and the
 * device would have gone on being told to open the app.
 */
describe("a sign-out that arrives after the session ran out", () => {
	beforeEach(async () => {
		await seed({ phone: Date.now() + DAY });
	});

	it("ends the session and its subscription", async () => {
		const { path } = await device("phone");
		await expire("phone");
		const res = await as("phone", "/auth/logout");
		expect(res.status).toBe(200);
		expect(await pushRows()).toEqual([]);

		await deliver("After signing out");
		expect(await arrivedAt(path)).toBe(0);
	});

	/**
	 * A cookie goes along with whatever a page makes the browser send --
	 * `<a ping>` in a message, measured -- so it signs nobody out.
	 */
	it("is not taken from a cookie", async () => {
		await device("phone");
		const res = await SELF.fetch(`${API}/auth/logout`, {
			method: "POST",
			headers: { Cookie: "session=phone" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Set-Cookie")).toBeNull();
		expect(await pushRows()).toHaveLength(1);
		const me = await SELF.fetch(`${API}/auth/me`, {
			headers: { Authorization: "Bearer phone" },
		});
		expect(me.status).toBe(200);
	});
});

/**
 * A subscribe that arrives after its session was ended on purpose -- the
 * browser's request overtaken by the sign-out -- names a session that is
 * gone. It is nobody's device now: not told anything, and swept.
 */
it("a subscription whose session was ended is never delivered, and is swept", async () => {
	await seed({ phone: Date.now() + DAY });
	expect((await as("phone", "/auth/logout")).status).toBe(200);
	const browser = await browserSubscription();
	const path = `/device/${crypto.randomUUID()}`;
	await inAuth((auth) =>
		auth.savePushSubscription(
			"owner",
			"phone",
			`${PUSH_ORIGIN}${path}`,
			browser.keys,
		),
	);

	await deliver("To nobody");
	expect(await arrivedAt(path)).toBe(0);

	expect((await login()).status).toBe(200);
	expect(await pushRows()).toEqual([]);
});

/**
 * Rows from before subscriptions named a session were delivered sender and
 * subject without end. The migration marks each lapsed (`lapsed_at`), so it
 * is told only to open the app -- and changes nothing the Worker before it
 * reads: the row still names no session, and no session is made for it. A
 * first version bound each to an expired session of its own, and a deploy
 * rolled back after it ran would have left the Worker before it delivering
 * nothing to those rows, and sweeping them at its next sign-in.
 *
 * Run here against such rows, from the shipped migration: a test object
 * starts empty, so the migration itself meets no rows.
 */
describe("the migration for rows that name no session", () => {
	const migration = authMigrations.find((m) => m.name === "10_push_lapsed");
	// The statement that marks them; the rest add the columns, which a test
	// object already has.
	const marking = (migration?.sql ?? "")
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => /^UPDATE\b/i.test(statement));

	it("ships the statement that marks them, and none that binds them", () => {
		expect(marking).toHaveLength(1);
		expect(migration?.sql).not.toMatch(/INSERT\s+INTO\s+sessions/i);
		expect(migration?.sql).not.toMatch(/SET\s+session_id/i);
	});

	/** A subscription saved before subscriptions named a session. */
	async function oldDevice(id: string) {
		const browser = await browserSubscription();
		const path = `/old/${crypto.randomUUID()}`;
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, 'owner', ?, ?, ?, 0)",
				id,
				`${PUSH_ORIGIN}${path}`,
				browser.keys.p256dh,
				browser.keys.auth,
			);
		});
		return { browser, path };
	}

	const migrate = () =>
		runInDurableObject(authStub(), async (_i, state) => {
			for (const statement of marking) state.storage.sql.exec(statement);
		});

	const sessionCount = () =>
		runInDurableObject(authStub(), async (_i, state) =>
			Number(
				state.storage.sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n,
			),
		);

	/**
	 * What the Worker before this one asks, word for word: it delivers to a
	 * row naming no session, and its sign-in sweeps rows through expired
	 * sessions. Rolled back to it, the rows are read as they were.
	 */
	const toldByTheWorkerBefore = () =>
		runInDurableObject(authStub(), async (_i, state) => {
			const now = Date.now();
			state.storage.sql.exec(
				"DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE expires_at < ?)",
				now,
			);
			return state.storage.sql
				.exec(
					`SELECT p.id
                       FROM push_subscriptions p
                  LEFT JOIN sessions s ON s.id = p.session_id
                      WHERE p.user_id IN (?)
                        AND (p.session_id IS NULL OR s.expires_at > ?)`,
					"owner",
					now,
				)
				.toArray()
				.map((row) => String(row.id));
		});

	it("leaves each naming no session, and makes it a lapsed device, told only to open the app", async () => {
		await seed({});
		const { browser, path } = await oldDevice("old");
		const sessionsBefore = await sessionCount();
		// Unmarked, it is told nothing at all.
		await deliver("Before the migration");
		expect(await arrivedAt(path)).toBe(0);

		await migrate();
		const [row] = await runInDurableObject(authStub(), async (_i, state) =>
			state.storage.sql
				.exec("SELECT session_id, lapsed_at FROM push_subscriptions")
				.toArray(),
		);
		expect(row.session_id).toBeNull();
		expect(Math.abs(Number(row.lapsed_at) - Date.now())).toBeLessThan(60_000);
		expect(await sessionCount()).toBe(sessionsBefore);
		expect(await toldByTheWorkerBefore()).toEqual(["old"]);

		await deliver("After the migration");
		const pushes = await read(browser, path);
		expect(pushes).toEqual([
			{ title: "Email Explorer", body: UNSAID, url: "/login", tag: "open-app" },
		]);
		sayNothingOf(pushes, "After the migration");
		const [message] = (await messages()).filter(
			(m) => m.subject === "After the migration",
		);
		expect(message.notified).toBe(0);
	});

	it("is silenced, as any lapsed device is, by a password change", async () => {
		await seed({ laptop: Date.now() + DAY });
		const { path } = await oldDevice("old");
		await migrate();
		const res = await as("laptop", "/auth/change-password", {
			currentPassword: PASSWORD,
			newPassword: "a-brand-new-password",
		});
		expect(res.status).toBe(200);
		expect(await pushRows()).toEqual([]);

		await deliver("After the password change");
		expect(await arrivedAt(path)).toBe(0);
	});

	/**
	 * Never live, whatever the clocks say: the mark is SQLite's clock and the
	 * time it is compared with the Worker's, which may be a moment behind.
	 * Read as a session's expiry, a mark ahead of the Worker's clock was a
	 * session still good -- told the message, and sent its dismissal.
	 */
	it("is never told the message, even marked ahead of the Worker's clock", async () => {
		await seed({ reader: Date.now() + DAY });
		const reader = await device("reader");
		const { browser, path } = await oldDevice("old");
		await migrate();
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE push_subscriptions SET lapsed_at = ?",
				Date.now() + 60_000,
			);
		});

		await deliver("Ahead of the clock");
		expect(await read(browser, path)).toEqual([
			{ title: "Email Explorer", body: UNSAID, url: "/login", tag: "open-app" },
		]);
		// Read on the device that was told: its dismissal goes to it alone.
		const [message] = await messages();
		expect(message.notified).toBe(1);
		const res = await as(
			"reader",
			`/mailboxes/${MAILBOX}/emails/${message.id}`,
			{ read: true },
			"PUT",
		);
		expect(res.status).toBe(200);
		expect(await arrivedAt(reader.path)).toBe(2);
		expect(await arrivedAt(path)).toBe(1);
	});

	/** Both edges of the window, as for a session that ran out. */
	it("is kept for as long as a lapsed session is, and swept by a sign-in after that", async () => {
		await seed({});
		const inside = await oldDevice("inside");
		const past = await oldDevice("past");
		await migrate();
		await runInDurableObject(authStub(), async (_i, state) => {
			const now = Date.now();
			state.storage.sql.exec(
				"UPDATE push_subscriptions SET lapsed_at = ? WHERE id = 'inside'",
				now - KEPT + 60_000,
			);
			state.storage.sql.exec(
				"UPDATE push_subscriptions SET lapsed_at = ? WHERE id = 'past'",
				now - KEPT - 1,
			);
		});

		await deliver("Near the end of the month");
		expect(await arrivedAt(inside.path)).toBe(1);
		expect(await arrivedAt(past.path)).toBe(0);

		expect((await login()).status).toBe(200);
		const left = await runInDurableObject(authStub(), async (_i, state) =>
			state.storage.sql
				.exec("SELECT id FROM push_subscriptions ORDER BY id")
				.toArray()
				.map((row) => String(row.id)),
		);
		expect(left).toEqual(["inside"]);
	});
});

/**
 * The label is only the title's first words, read from the bucket after the
 * lapsed devices' day is already marked: R2 refusing that one read used to
 * take every notification with it, the lapsed device's day included. Called
 * directly, since a delivery reads the same object earlier and fails there.
 */
it("a label that cannot be read costs the title, not the notifications", async () => {
	await seed({ phone: Date.now() + DAY, laptop: Date.now() + DAY });
	const phone = await device("phone");
	const laptop = await device("laptop");
	await expire("phone");
	const refusing = {
		...env,
		BUCKET: {
			get: async () => {
				throw new Error(
					"get: Reduce your rate of simultaneous reads on the same object. (10058)",
				);
			},
		},
	};

	// Called from inside an object rather than from the test itself: made
	// from here, a call to the auth object that failed left the runner
	// hanging once the tests were done (measured with its query broken).
	const announced = await runInDurableObject(mailboxStub(), () =>
		notifyNewEmail(refusing as never, MAILBOX, {
			id: "message-1",
			sender: SENDER,
			subject: "Unlabelled",
		}),
	);
	expect(announced).toBe(true);
	const [shown] = await read(laptop.browser, laptop.path);
	expect(shown.title).toBe(`[${MAILBOX}] ${SENDER}`);
	expect(await read(phone.browser, phone.path)).toEqual([
		{ title: "Email Explorer", body: UNSAID, url: "/login", tag: "open-app" },
	]);
	const marked = (await pushRows()).find((row) => row.session_id === "phone");
	expect(marked?.notice_at).not.toBeNull();
});

/**
 * The language a device is told in is the one its page last displayed. A
 * code the notice does not have is kept as none, never refused: the
 * dashboard swallows a refusal, so a refusal left the device silent.
 */
describe("the language of the notice", () => {
	beforeEach(async () => {
		await seed({ phone: Date.now() + DAY });
	});

	it("is the device's", async () => {
		const { browser, path } = await device("phone", "fr");
		expect((await pushRows())[0].locale).toBe("fr");
		await expire("phone");
		await deliver("En français");
		const [push] = await read(browser, path);
		expect(push.body).toBe(OPEN_THE_APP.fr);
	});

	it("is none for a code it does not know, and the subscription is kept", async () => {
		for (const locale of [
			"xx-YY",
			"a-much-longer-code-than-any-language",
			42,
		]) {
			await device("phone", locale);
		}
		const rows = await pushRows();
		expect(rows).toHaveLength(3);
		expect(rows.map((row) => row.locale)).toEqual([null, null, null]);
	});

	it("is the default language and English when the device never said", async () => {
		const { browser, path } = await device("phone");
		await expire("phone");
		await deliver("Unsaid");
		const [push] = await read(browser, path);
		expect(push.body.split("\n")).toEqual(UNSAID_LINES);
	});
});

/**
 * A dismissal is a push that shows nothing, and Safari is documented to
 * revoke the permission of a site that sends those. So none goes to Apple's
 * push service; a notification Safari shows stays until it is tapped.
 */
it("a dismissal goes to other push services and not to Apple's", async () => {
	await seed({ phone: Date.now() + DAY, iphone: Date.now() + DAY });
	const other = await device("phone");
	const apple = await browserSubscription();
	const applePath = `/apple/${crypto.randomUUID()}`;
	expect(
		(
			await as("iphone", "/push/subscribe", {
				endpoint: `https://web.push.apple.com${applePath}`,
				keys: apple.keys,
			})
		).status,
	).toBe(200);

	await deliver("Seen on both");
	const [message] = await messages();
	expect(message.notified).toBe(1);
	const res = await as(
		"phone",
		`/mailboxes/${MAILBOX}/emails/${message.id}`,
		{ read: true },
		"PUT",
	);
	expect(res.status).toBe(200);

	expect(await arrivedAt(other.path)).toBe(2);
	expect(await arrivedAt(applePath, "web.push.apple.com")).toBe(1);
});

/**
 * A statement may bind a hundred values. A mailbox held through a hundred
 * logins asks about a hundred ids, and the time is one more.
 */
it("a mailbox held through a hundred logins is asked about in more than one statement", async () => {
	await seed({});
	await runInDurableObject(authStub(), async (_i, state) => {
		const now = Date.now();
		for (let i = 0; i < 100; i++) {
			state.storage.sql.exec(
				"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES (?, ?, 'x', 0, 'person-owner', ?, ?)",
				`login-${i}`,
				`login-${i}@example.com`,
				now,
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
				`s-${i}`,
				`login-${i}`,
				now - 1,
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 'k', 'a', ?)",
				`p-${i}`,
				`login-${i}`,
				`s-${i}`,
				`https://push-ok.example.test/${i}`,
				now,
			);
		}
	});
	const holders = await authStub().getUserIdsForMailbox(MAILBOX);
	expect(holders.length).toBeGreaterThanOrEqual(100);
	// Inside the object (inAuth): a statement refused for its size failed
	// this test over RPC and then left the runner hanging.
	const { live, lapsed } = await inAuth((auth) =>
		auth.pushTargetsForNewMail(holders),
	);
	expect(live).toEqual([]);
	expect(lapsed).toHaveLength(100);
	const marked = await runInDurableObject(authStub(), async (_i, state) =>
		state.storage.sql
			.exec(
				"SELECT COUNT(*) AS n FROM push_subscriptions WHERE notice_at IS NOT NULL",
			)
			.one(),
	);
	expect(Number(marked.n)).toBe(100);
});

/**
 * A refusal used to leave no trace, so a device that stopped hearing
 * anything was a question nobody could answer. What is written is the push
 * service and the status -- never the endpoint, whose path is what reaches
 * the device, for anyone who holds it.
 */
describe("what a failed send leaves in the log", () => {
	let logged: string[] = [];
	beforeEach(async () => {
		await seed({ phone: Date.now() + DAY });
		logged = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function subscribedAt(
		host: string,
		keys?: { p256dh: string; auth: string },
	) {
		const browser = await browserSubscription();
		const secretPath = `/${crypto.randomUUID()}`;
		const res = await as("phone", "/push/subscribe", {
			endpoint: `https://${host}${secretPath}`,
			keys: keys ?? browser.keys,
		});
		expect(res.status).toBe(200);
		return secretPath.slice(1);
	}

	it("names the push service and its answer for a refusal", async () => {
		const secret = await subscribedAt("push-busy.example.test");
		await deliver("Busy");
		const line = logged.find((l) => l.includes("push-busy.example.test"));
		expect(line).toBeDefined();
		expect(line).toContain("429");
		expect(logged.join("\n")).not.toContain(secret);
	});

	/**
	 * A send that throws -- here a subscription whose key is no key, which
	 * the push request cannot be built for. The error's own text is not
	 * written either: it may quote the endpoint.
	 */
	it("names only the push service when the send fails", async () => {
		const secret = await subscribedAt("push-ok.example.test", {
			p256dh: "not-a-key",
			auth: "not-a-secret",
		});
		await deliver("Unsendable");
		const line = logged.find((l) => l.startsWith("Failed to send push"));
		expect(line).toBeDefined();
		expect(line).toContain("push-ok.example.test");
		expect(logged.join("\n")).not.toContain(secret);
	});
});
