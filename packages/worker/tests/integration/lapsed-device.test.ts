import {
	createExecutionContext,
	env,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMigrations } from "../../src/durableObject/migrations";
import { DEFAULT_MAIL_LOCALE } from "../../src/mail-templates";
import { hashPassword } from "../../src/password";
import { OPEN_THE_APP } from "../../src/push-notice";
import {
	arrivedAt,
	type Browser,
	browserSubscription,
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
 * change to the constant is a change this test notices. */
const KEPT = 30 * DAY;

const authStub = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
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
		const earlier = await authStub().pushTargetsForNewMail(holders);
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
		const later = await authStub().pushTargetsForNewMail(holders);
		expect(later.lapsed).toHaveLength(1);
		expect(later.noticeAt).toBeGreaterThan(earlier.noticeAt);

		// ...and only then does the earlier send's refusal come back.
		await authStub().lapsedNoticesNotSent(
			earlier.lapsed.map((target) => target.endpoint),
			earlier.noticeAt,
		);
		expect((await pushRows())[0].notice_at).toBe(later.noticeAt);
		await deliver("The same day as the later notice");
		expect(await arrivedAt(path)).toBe(0);
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
	await authStub().savePushSubscription(
		"owner",
		"phone",
		`${PUSH_ORIGIN}${path}`,
		browser.keys,
	);

	await deliver("To nobody");
	expect(await arrivedAt(path)).toBe(0);

	expect((await login()).status).toBe(200);
	expect(await pushRows()).toEqual([]);
});

/**
 * Rows from before subscriptions named a session were delivered sender and
 * subject without end. The migration binds each to a session of its own that
 * has already run out, so it is told only to open the app. Run here against
 * such a row, from the shipped migration: a test object starts empty, so the
 * migration itself meets no rows.
 */
describe("the migration for rows that name no session", () => {
	const migration = authMigrations.find((m) => m.name === "10_push_lapsed");
	const binding = (migration?.sql ?? "")
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => /^(INSERT|UPDATE)\b/i.test(statement));

	it("ships the statements that bind them", () => {
		expect(binding).toHaveLength(2);
	});

	it("makes each a lapsed device, told only to open the app", async () => {
		await seed({});
		const browser = await browserSubscription();
		const path = `/old/${crypto.randomUUID()}`;
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('old', 'owner', ?, ?, ?, 0)",
				`${PUSH_ORIGIN}${path}`,
				browser.keys.p256dh,
				browser.keys.auth,
			);
		});
		// Unbound, it is told nothing at all.
		await deliver("Before the migration");
		expect(await arrivedAt(path)).toBe(0);

		await runInDurableObject(authStub(), async (_i, state) => {
			for (const statement of binding) state.storage.sql.exec(statement);
		});
		await deliver("After the migration");
		const pushes = await read(browser, path);
		expect(pushes).toEqual([
			{ title: "Email Explorer", body: UNSAID, url: "/login", tag: "open-app" },
		]);
		sayNothingOf(pushes, "After the migration");
		// The session made for it signs nobody in.
		expect(await authStub().validateSession("lapsed-old")).toBeNull();
		const me = await SELF.fetch(`${API}/auth/me`, {
			headers: { Authorization: "Bearer lapsed-old" },
		});
		expect(me.status).toBe(401);
	});
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
	// Inside the object rather than over RPC: a statement refused for its
	// size failed this test and then left the runner hanging, the refusal
	// reported as uncaught in the object, until the job's timeout.
	const { live, lapsed } = await runInDurableObject(authStub(), (instance) =>
		instance.pushTargetsForNewMail(holders),
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
