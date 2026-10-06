import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVICE_TTL_MS, deviceHash } from "../../src/login-device";
import { hashPassword } from "../../src/password";
import { enableAccountRecovery } from "./utils";

/**
 * A stranger's failed sign-ins lock out a known address -- and they used to
 * lock out its owner with it: ten wrong passwords from anywhere, every
 * fifteen minutes, and the right one was refused too, root's included. A
 * browser that has proved the password before is now counted on a key of
 * its own (login-device.ts), while everything without that cookie still
 * shares the address's ten.
 *
 * Both sides are asked: the owner's browser is let in under a stranger's
 * lock, and nothing else is -- no cookie, a made-up one, another login's, a
 * stale one, a copy the owner has moved on from.
 */

const API = "http://local.test/api/v1";
const EMAIL = "owner@example.com";
const OTHER = "other@example.com";
const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "a-new-password-entirely";
const OWNER_IP = "203.0.113.9";
const STRANGER_IP = "198.51.100.7";

function authStub() {
	return env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
}

async function seedLogin(id: string, email: string, person = `person-${id}`) {
	const hash = await hashPassword(PASSWORD);
	await runInDurableObject(authStub(), async (_i, state) => {
		const now = Date.now();
		state.storage.sql.exec(
			"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
			id,
			email,
			hash,
			person,
			now,
			now,
		);
	});
}

const login = (
	password: string,
	{
		ip = OWNER_IP,
		cookie,
		email = EMAIL,
	}: { ip?: string; cookie?: string; email?: string } = {},
) =>
	SELF.fetch(`${API}/auth/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"CF-Connecting-IP": ip,
			...(cookie ? { Cookie: cookie } : {}),
		},
		body: JSON.stringify({ email, password }),
	});

const changePassword = (session: string, currentPassword = PASSWORD) =>
	SELF.fetch(`${API}/auth/change-password`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${session}`,
			"CF-Connecting-IP": OWNER_IP,
		},
		body: JSON.stringify({
			currentPassword,
			newPassword: NEW_PASSWORD,
		}),
	});

/**
 * The `login_device` cookie a response hands out, as a `name=value` pair to
 * send back -- after checking it has the attributes that keep it to the
 * sign-in request and out of the page's reach, which every response that
 * hands one out must give it.
 */
function deviceCookieOf(res: Response): string {
	const raw = res.headers
		.getSetCookie()
		.find((c) => c.startsWith("login_device="));
	expect(raw, "a login_device cookie").toBeDefined();
	const attributes = (raw as string)
		.split(";")
		.slice(1)
		.map((a) => a.trim());
	expect(attributes).toEqual(
		expect.arrayContaining([
			"HttpOnly",
			"Secure",
			"SameSite=Strict",
			"Path=/api/v1/auth/login",
			`Max-Age=${DEVICE_TTL_MS / 1000}`,
		]),
	);
	expect(attributes.some((a) => a.toLowerCase().startsWith("domain"))).toBe(
		false,
	);
	return (raw as string).split(";")[0];
}

const hasDeviceCookie = (res: Response) =>
	res.headers.getSetCookie().some((c) => c.startsWith("login_device="));

/** Ten wrong passwords from somewhere else, and the address is locked. */
async function strangerLocks(email = EMAIL) {
	for (let i = 0; i < 10; i++) {
		await login("wrong", { ip: STRANGER_IP, email });
	}
	expect((await login("wrong", { ip: STRANGER_IP, email })).status).toBe(429);
}

const deviceRows = () =>
	runInDurableObject(authStub(), async (_i, state) =>
		state.storage.sql
			.exec("SELECT token_hash, user_id, failures FROM login_devices")
			.toArray(),
	);

const tally = (statuses: number[]) =>
	statuses.reduce<Record<number, number>>((acc, s) => {
		acc[s] = (acc[s] ?? 0) + 1;
		return acc;
	}, {});

describe("a browser that has signed in before", () => {
	beforeEach(async () => {
		await seedLogin("owner", EMAIL);
		await seedLogin("other", OTHER);
	});

	it("is handed a cookie for the sign-in route, beside the session's", async () => {
		const res = await login(PASSWORD);
		expect(res.status).toBe(200);
		deviceCookieOf(res);
		expect(
			res.headers.getSetCookie().some((c) => c.startsWith("session=")),
		).toBe(true);
	});

	it("signs in with the right password while a stranger has the address locked", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(200);
	});

	it("without the cookie, the owner is refused as before", async () => {
		await login(PASSWORD);
		await strangerLocks();
		const res = await login(PASSWORD);
		expect(res.status).toBe(429);
		expect(hasDeviceCookie(res)).toBe(false);
	});

	it("leaves the stranger locked out when it signs in", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(200);
		// Its success clears its own key, not the address's.
		expect((await login(PASSWORD, { ip: STRANGER_IP })).status).toBe(429);
		expect((await login(PASSWORD, { ip: "192.0.2.77" })).status).toBe(429);
	});

	it("counts for nothing when the token is made up, or another login's", async () => {
		const othersCookie = deviceCookieOf(
			await login(PASSWORD, { email: OTHER }),
		);
		await strangerLocks();
		const madeUp = `login_device=${"A".repeat(43)}`;
		expect((await login(PASSWORD, { cookie: madeUp })).status).toBe(429);
		expect((await login(PASSWORD, { cookie: othersCookie })).status).toBe(429);
	});

	it("has a limit of its own: ten wrong, and then even the right one is refused", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		for (let i = 0; i < 10; i++) {
			expect((await login("wrong", { cookie })).status).toBe(401);
		}
		expect((await login(PASSWORD, { cookie })).status).toBe(429);
	});

	it("verifies no more than ten of a burst", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		const responses = await Promise.all(
			Array.from({ length: 25 }, () => login("wrong", { cookie })),
		);
		expect(tally(responses.map((r) => r.status))).toEqual({
			401: 10,
			429: 15,
		});
	});

	it("is still held by its network's limit, with everyone else there", async () => {
		// Four logins, each with a browser it trusts: four keys of their own,
		// and the browsers' keys are not all that counts.
		const logins = [EMAIL, OTHER, "third@example.com", "fourth@example.com"];
		await seedLogin("third", logins[2]);
		await seedLogin("fourth", logins[3]);
		const cookies: string[] = [];
		for (const [i, email] of logins.entries()) {
			cookies.push(
				deviceCookieOf(
					await login(PASSWORD, { email, ip: `192.0.2.${i + 1}` }),
				),
			);
		}
		// Nine wrong each, from one network: under every browser's ten, over
		// the network's thirty.
		const network = "198.51.100.50";
		const statuses: number[] = [];
		for (let round = 0; round < 9; round++) {
			for (const [i, email] of logins.entries()) {
				const res = await login("wrong", {
					email,
					ip: network,
					cookie: cookies[i],
				});
				statuses.push(res.status);
			}
		}
		expect(tally(statuses)).toEqual({ 401: 30, 429: 6 });
		// It was the network that was locked, not the browsers.
		expect((await login(PASSWORD, { cookie: cookies[0] })).status).toBe(200);
	});

	it("is not pushed aside by a planted login_device sent ahead of ours", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		await strangerLocks();
		const planted = `login_device=${"B".repeat(43)}`;
		expect(
			(await login(PASSWORD, { cookie: `${planted}; ${cookie}` })).status,
		).toBe(200);
	});

	it("signs nothing in anywhere else", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		const headers = { Cookie: cookie, "CF-Connecting-IP": OWNER_IP };
		expect((await SELF.fetch(`${API}/mailboxes`, { headers })).status).toBe(
			401,
		);
		// Nor where the session cookie does sign in.
		expect(
			(
				await SELF.fetch(`${API}/mailboxes/m/emails/e/attachments/a`, {
					headers,
				})
			).status,
		).toBe(401);
	});

	it("stores the token's digest and never the token", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		const token = cookie.slice("login_device=".length);
		const rows = await deviceRows();
		expect(rows).toHaveLength(1);
		expect(String(rows[0].token_hash)).toBe(await deviceHash(token));
		expect(JSON.stringify(rows)).not.toContain(token);
	});
});

describe("a copy of the cookie", () => {
	beforeEach(() => seedLogin("owner", EMAIL));

	it("stops working once the owner signs in again", async () => {
		const copy = deviceCookieOf(await login(PASSWORD));
		const again = await login(PASSWORD, { cookie: copy });
		expect(again.status).toBe(200);
		const fresh = deviceCookieOf(again);
		expect(fresh).not.toBe(copy);
		await strangerLocks();
		expect((await login(PASSWORD, { cookie: fresh })).status).toBe(200);
		expect((await login(PASSWORD, { cookie: copy })).status).toBe(429);
	});

	it("loses its standing at the failure cap", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		// Ninety-nine failures already, spread over the windows they took.
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec("UPDATE login_devices SET failures = 99");
		});
		expect((await login("wrong", { cookie })).status).toBe(401);
		expect(await deviceRows()).toHaveLength(0);
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(429);
	});

	it("has its failures cleared by a success, which takes the cap with it", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		expect((await login("wrong", { cookie })).status).toBe(401);
		expect(Number((await deviceRows())[0]?.failures)).toBe(1);
		expect((await login(PASSWORD, { cookie })).status).toBe(200);
		const rows = await deviceRows();
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].failures)).toBe(0);
	});

	it("is not trusted once its standing is older than its lifetime", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE login_devices SET granted_at = ?",
				Date.now() - DEVICE_TTL_MS - 1000,
			);
		});
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(429);
	});
});

describe("what ends a browser's standing", () => {
	beforeEach(() => seedLogin("owner", EMAIL));

	it("a stamp that is not the login's current one is not trusted", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec("UPDATE login_devices SET stamp = 'stale'");
		});
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(429);
	});

	it("a password change ends every other browser's, and the changing one keeps its own", async () => {
		// Another browser, which proved the old password.
		const elsewhere = deviceCookieOf(await login(PASSWORD));
		const here = await login(PASSWORD);
		const { id: session } = (await here.json()) as { id: string };
		const changed = await changePassword(session);
		expect(changed.status).toBe(200);
		const kept = deviceCookieOf(changed);
		await strangerLocks();
		expect((await login(NEW_PASSWORD, { cookie: kept })).status).toBe(200);
		expect((await login(NEW_PASSWORD, { cookie: elsewhere })).status).toBe(429);
	});

	it("leaves no browser trusted that signed in while the password was being changed", async () => {
		const here = await login(PASSWORD);
		const { id: session } = (await here.json()) as { id: string };

		// Twenty sign-ins with the old password, from twenty networks, sent
		// with the change. Granted in a call of its own, the standing of each
		// one that got in survived the change -- ten of ten, measured.
		const ips = Array.from({ length: 20 }, (_, i) => `198.51.100.${i + 10}`);
		const [changed, ...racing] = await Promise.all([
			changePassword(session),
			...ips.map((ip) => login(PASSWORD, { ip })),
		]);
		expect(changed.status).toBe(200);
		const cookies = racing.filter((r) => r.status === 200).map(deviceCookieOf);
		expect(cookies.length).toBeGreaterThan(0);

		await strangerLocks();
		// A guess from a browser still trusted would be answered 401 (counted
		// on its own key); from one that is not, 429 (the address is locked).
		const answers = [];
		for (const cookie of cookies) {
			answers.push(
				(await login("guess", { ip: "203.0.113.200", cookie })).status,
			);
		}
		expect(answers.filter((s) => s !== 429)).toEqual([]);
	});

	// The race above catches a grant made after the sign-in has answered,
	// but only when the timing falls that way, and a grant one round trip
	// after the password check slipped through it. This holds the
	// arrangement itself: the call that verifies the password is the call
	// that grants, so nothing can land in between.
	it("is granted by the very call that verified the password", async () => {
		const grant = await deviceHash("C".repeat(43));
		const auth = authStub();
		expect(
			await auth.login(EMAIL, PASSWORD, { trusted: null, grant }),
		).not.toBeNull();
		expect((await deviceRows()).map((r) => r.token_hash)).toEqual([grant]);
		// And not by one that refused it.
		const other = await deviceHash("D".repeat(43));
		expect(
			await auth.login(EMAIL, "wrong", { trusted: null, grant: other }),
		).toBeNull();
		expect((await deviceRows()).map((r) => r.token_hash)).toEqual([grant]);
	});

	it("root setting the password ends every browser's", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		expect(await authStub().setUserPassword("owner", NEW_PASSWORD)).toBe("ok");
		expect(await deviceRows()).toHaveLength(0);
		await strangerLocks();
		expect((await login(NEW_PASSWORD, { cookie })).status).toBe(429);
	});

	it("moving the login to another address ends it, until it signs in there", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		const stamp = (await authStub().emailChangeStamp("owner")) as string;
		const MOVED = "moved@example.com";
		expect(await authStub().confirmEmailChange("owner", MOVED, stamp)).toBe(
			"changed",
		);
		await strangerLocks(MOVED);
		expect((await login(PASSWORD, { cookie, email: MOVED })).status).toBe(429);

		// Signed in at the new address, it is trusted there.
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec("DELETE FROM auth_throttle");
		});
		const there = deviceCookieOf(await login(PASSWORD, { email: MOVED }));
		await strangerLocks(MOVED);
		expect(
			(await login(PASSWORD, { cookie: there, email: MOVED })).status,
		).toBe(200);
	});

	it("moving the login away and back does not bring it back", async () => {
		const cookie = deviceCookieOf(await login(PASSWORD));
		const auth = authStub();
		for (const to of ["moved@example.com", EMAIL]) {
			const stamp = (await auth.emailChangeStamp("owner")) as string;
			expect(await auth.confirmEmailChange("owner", to, stamp)).toBe("changed");
		}
		// Back at the address it proved, under the password it proved: the
		// stamp is the one it was granted under, so the rows have to go.
		expect(await deviceRows()).toHaveLength(0);
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(429);
	});

	it("a move of the address that is refused leaves it as it was", async () => {
		await seedLogin("other", OTHER);
		const cookie = deviceCookieOf(await login(PASSWORD));
		const auth = authStub();
		expect(
			await auth.confirmEmailChange("owner", "moved@example.com", "stale"),
		).toBe("stale");
		const stamp = (await auth.emailChangeStamp("owner")) as string;
		expect(await auth.confirmEmailChange("owner", OTHER, stamp)).toBe("taken");
		expect(await deviceRows()).toHaveLength(1);
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(200);
	});

	it("a lapsed standing is swept by the next grant, and only a lapsed one", async () => {
		await seedLogin("other", OTHER);
		const kept = deviceCookieOf(await login(PASSWORD));
		await login(PASSWORD, { email: OTHER });
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE login_devices SET granted_at = ? WHERE user_id = 'other'",
				Date.now() - DEVICE_TTL_MS - 1000,
			);
		});
		// A browser that is never seen again never presents its token, so
		// nothing but the sweep takes its row.
		await login(PASSWORD, { ip: "192.0.2.80" });
		const rows = await deviceRows();
		expect(rows.map((r) => r.user_id)).toEqual(["owner", "owner"]);
		expect(rows.map((r) => r.token_hash)).toContain(
			await deviceHash(kept.slice("login_device=".length)),
		);
	});

	it("deleting the login takes its rows", async () => {
		await seedLogin("spare", "spare@example.com", "person-owner");
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE users SET person_id = 'person-owner' WHERE id = 'owner'",
			);
		});
		await login(PASSWORD);
		await login(PASSWORD, { email: "spare@example.com" });
		expect(await deviceRows()).toHaveLength(2);
		expect(await authStub().deleteLogin("owner")).toBe("ok");
		const rows = await deviceRows();
		expect(rows.map((r) => r.user_id)).toEqual(["spare"]);
	});

	it("deleting the person takes their rows", async () => {
		await login(PASSWORD);
		expect(await deviceRows()).toHaveLength(1);
		const out = await authStub().deletePerson("person-owner");
		expect(out.status).toBe("ok");
		expect(await deviceRows()).toHaveLength(0);
	});
});

describe("the browsers that start out trusted", () => {
	it("the one that registered", async () => {
		const res = await SELF.fetch(`${API}/auth/register`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"CF-Connecting-IP": OWNER_IP,
			},
			body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
		});
		expect(res.status).toBe(201);
		const cookie = deviceCookieOf(res);
		expect(
			res.headers.getSetCookie().some((c) => c.startsWith("session=")),
		).toBe(true);
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(200);
	});

	it("the one that finished a reset", async () => {
		await seedLogin("owner", EMAIL);
		await enableAccountRecovery();
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
		const reset = await SELF.fetch(`${API}/auth/reset-password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
		});
		expect(reset.status).toBe(200);
		const cookie = deviceCookieOf(reset);
		await strangerLocks();
		expect((await login(NEW_PASSWORD, { cookie })).status).toBe(200);
	});

	it("one that signed in on a legacy hash, under the hash it was moved onto", async () => {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(PASSWORD),
		);
		const legacy = [...new Uint8Array(digest)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		await runInDurableObject(authStub(), async (_i, state) => {
			const now = Date.now();
			state.storage.sql.exec(
				"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES ('owner', ?, ?, 0, 'person-owner', ?, ?)",
				EMAIL,
				legacy,
				now,
				now,
			);
		});
		const cookie = deviceCookieOf(await login(PASSWORD));
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(200);
	});

	it("and no other: a refused sign-in or reset hands out nothing", async () => {
		await seedLogin("owner", EMAIL);
		expect(hasDeviceCookie(await login("wrong"))).toBe(false);
		await enableAccountRecovery();
		const reset = await SELF.fetch(`${API}/auth/reset-password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: "no-such-token",
				newPassword: "x".repeat(8),
			}),
		});
		expect(reset.status).toBe(401);
		expect(hasDeviceCookie(reset)).toBe(false);
		expect(await deviceRows()).toHaveLength(0);
	});

	it("nor a refused password change, which leaves the browser's own", async () => {
		await seedLogin("owner", EMAIL);
		const first = await login(PASSWORD);
		const cookie = deviceCookieOf(first);
		const { id: session } = (await first.json()) as { id: string };
		const refused = await changePassword(session, "not-the-password");
		expect(refused.status).toBe(403);
		// A cookie handed out here would have no row behind it and would
		// replace the browser's own: one mistyped current password, and the
		// owner was counted with the stranger again.
		expect(hasDeviceCookie(refused)).toBe(false);
		await strangerLocks();
		expect((await login(PASSWORD, { cookie })).status).toBe(200);
	});
});
