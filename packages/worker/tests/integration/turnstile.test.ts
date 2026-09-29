import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TURNSTILE_KEY,
	TURNSTILE_VERIFIED_KEY,
	VERIFIED_FOR_MS,
} from "../../src/turnstile";

/**
 * Turnstile in front of sign-in, registration and the reset request.
 *
 * Root sets it on /root, and only a pair that has been seen to work can be
 * saved: a wrong one would refuse every sign-in, root's with them, and the
 * screen that puts it right is behind the sign-in. The same fear is why a
 * secret Cloudflare no longer knows lets requests through rather than
 * refusing them.
 *
 * siteverify is stubbed in vitest.config.mts: `PASS:<secret>` is the token
 * that passes with that secret, and nothing else does.
 */

const SITE = "0x4AAAAAAAsitekeyForTests";
const SECRET = "0x4AAAAAAAsecretForTestsEndsWITH";
const OTHER_SECRET = "0x4AAAAAAAsecretOfAnotherWidget9";

const url = (path: string) => `http://local.test${path}`;
const json = (body: unknown, token?: string): RequestInit => ({
	headers: {
		"Content-Type": "application/json",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	},
	body: JSON.stringify(body),
});

const register = (body: Record<string, unknown>) =>
	SELF.fetch(url("/api/v1/auth/register"), { method: "POST", ...json(body) });
const login = (body: Record<string, unknown>) =>
	SELF.fetch(url("/api/v1/auth/login"), { method: "POST", ...json(body) });

/** Root, signed in: the first account registered. */
async function root(): Promise<string> {
	await register({ email: "op@example.com", password: "password123" });
	const response = await login({
		email: "op@example.com",
		password: "password123",
	});
	return (await response.json<{ id: string }>()).id;
}

const verify = (token: string, body: Record<string, unknown>) =>
	SELF.fetch(url("/api/v1/root/settings/turnstile/verify"), {
		method: "POST",
		...json(body, token),
	});
const save = (token: string, body: Record<string, unknown>) =>
	SELF.fetch(url("/api/v1/root/settings/turnstile"), {
		method: "PUT",
		...json(body, token),
	});
const state = async (token: string) =>
	(
		await SELF.fetch(url("/api/v1/root/settings/turnstile"), {
			headers: { Authorization: `Bearer ${token}` },
		})
	).json<{ siteKey: string | null; secretKey: string | null }>();
const publicSiteKey = async () =>
	(
		await (
			await SELF.fetch(url("/api/v1/settings"))
		).json<{
			turnstile: { siteKey: string | null };
		}>()
	).turnstile.siteKey;

/** Turns it on the way the screen does: check, then save. */
async function turnOn(token: string) {
	const checked = await verify(token, {
		siteKey: SITE,
		secretKey: SECRET,
		token: `PASS:${SECRET}`,
	});
	expect(checked.status).toBe(200);
	const saved = await save(token, { siteKey: SITE, secretKey: SECRET });
	expect(saved.status).toBe(200);
}

const rootLogin = (turnstileToken?: string) =>
	login({ email: "op@example.com", password: "password123", turnstileToken });

afterEach(() => {
	vi.restoreAllMocks();
});

describe("setting it on /root", () => {
	it("is off until root sets it", async () => {
		const token = await root();
		expect(await state(token)).toEqual({ siteKey: null, secretKey: null });
		expect(await publicSiteKey()).toBeNull();
		expect((await rootLogin()).status).toBe(200);
	});

	it("saves a pair that passed, and shows the secret by its last four only", async () => {
		const token = await root();
		await turnOn(token);

		expect(await state(token)).toEqual({
			siteKey: SITE,
			secretKey: "...WITH",
		});
		const everything = await (
			await SELF.fetch(url("/api/v1/root/settings/turnstile"), {
				headers: { Authorization: `Bearer ${token}` },
			})
		).text();
		expect(everything).not.toContain(SECRET);

		const open = await (await SELF.fetch(url("/api/v1/settings"))).text();
		expect(await publicSiteKey()).toBe(SITE);
		expect(open).not.toContain(SECRET);
		expect(open).not.toContain("WITH");
	});

	it("refuses a pair from two different widgets, and will not save it", async () => {
		const token = await root();
		// The widget rendered with SITE, so its token is SECRET's; checked
		// against another widget's secret it fails.
		const checked = await verify(token, {
			siteKey: SITE,
			secretKey: OTHER_SECRET,
			token: `PASS:${SECRET}`,
		});
		expect(checked.status).toBe(400);
		expect(await checked.json()).toMatchObject({
			verdict: "refused",
			codes: ["invalid-input-response"],
		});

		const saved = await save(token, { siteKey: SITE, secretKey: OTHER_SECRET });
		expect(saved.status).toBe(409);
		expect(await publicSiteKey()).toBeNull();
	});

	it("says so when the secret is one Cloudflare does not know", async () => {
		const token = await root();
		const checked = await verify(token, {
			siteKey: SITE,
			secretKey: "INVALID_SECRET-typo",
			token: "anything",
		});
		expect(checked.status).toBe(400);
		expect(await checked.json()).toMatchObject({ verdict: "secret-invalid" });
	});

	it("saves only the pair that passed, not another one", async () => {
		const token = await root();
		await verify(token, {
			siteKey: SITE,
			secretKey: SECRET,
			token: `PASS:${SECRET}`,
		});
		expect(
			(await save(token, { siteKey: SITE, secretKey: OTHER_SECRET })).status,
		).toBe(409);
		expect(
			(await save(token, { siteKey: "0x4another", secretKey: SECRET })).status,
		).toBe(409);
		expect(await publicSiteKey()).toBeNull();
	});

	it("will not save a pair checked too long ago", async () => {
		const token = await root();
		await verify(token, {
			siteKey: SITE,
			secretKey: SECRET,
			token: `PASS:${SECRET}`,
		});
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + VERIFIED_FOR_MS + 1000);
		expect(
			(await save(token, { siteKey: SITE, secretKey: SECRET })).status,
		).toBe(409);
	});

	it("is taken off by removing it, check and all", async () => {
		const token = await root();
		await turnOn(token);
		await verify(token, {
			siteKey: SITE,
			secretKey: SECRET,
			token: `PASS:${SECRET}`,
		});

		const removed = await SELF.fetch(url("/api/v1/root/settings/turnstile"), {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ siteKey: null, secretKey: null });
		expect(await env.BUCKET.head(TURNSTILE_KEY)).toBeNull();
		expect(await env.BUCKET.head(TURNSTILE_VERIFIED_KEY)).toBeNull();
		expect(await publicSiteKey()).toBeNull();
		expect((await rootLogin()).status).toBe(200);
	});
});

describe("once it is on", () => {
	it("refuses a sign-in with no token, or a bad one, and takes a good one", async () => {
		const token = await root();
		await turnOn(token);

		const none = await rootLogin();
		expect(none.status).toBe(403);
		expect(await none.json()).toEqual({ error: "Bot check failed" });
		expect((await rootLogin("forged")).status).toBe(403);
		expect((await rootLogin(`PASS:${OTHER_SECRET}`)).status).toBe(403);
		expect((await rootLogin(`PASS:${SECRET}`)).status).toBe(200);
	});

	it("refuses when siteverify gives no answer", async () => {
		const token = await root();
		await turnOn(token);
		expect((await rootLogin("UNANSWERED")).status).toBe(403);
	});

	it("spends nobody's attempts on a request it refused", async () => {
		const token = await root();
		await turnOn(token);
		// More than the ten an address is allowed, all with the right
		// password but no token: a bot that cannot pass cannot lock root out.
		for (let i = 0; i < 12; i++) {
			expect((await rootLogin("forged")).status).toBe(403);
		}
		expect((await rootLogin(`PASS:${SECRET}`)).status).toBe(200);
	});

	it("guards the reset request", async () => {
		const token = await root();
		await SELF.fetch(url("/api/v1/root/settings/account-recovery"), {
			method: "PUT",
			...json({ fromEmail: "noreply@example.com" }, token),
		});
		await turnOn(token);

		const ask = (turnstileToken?: string) =>
			SELF.fetch(url("/api/v1/auth/forgot-password"), {
				method: "POST",
				...json({ email: "op@example.com", turnstileToken }),
			});
		expect((await ask()).status).toBe(403);
		expect((await ask(`PASS:${SECRET}`)).status).toBe(200);
	});

	it("guards registration, and signs the new account in with the same token", async () => {
		// Set before anyone registers, so the form is still open.
		await env.BUCKET.put(
			TURNSTILE_KEY,
			JSON.stringify({ siteKey: SITE, secretKey: SECRET }),
		);
		const body = { email: "first@example.com", password: "password123" };

		expect((await register(body)).status).toBe(403);

		const made = await register({ ...body, turnstileToken: `PASS:${SECRET}` });
		expect(made.status).toBe(201);
		const { session } = await made.json<{
			session: { id: string; role: string };
		}>();
		expect(session.role).toBe("root");
		expect(made.headers.get("Set-Cookie")).toContain(`session=${session.id}`);

		const me = await SELF.fetch(url("/api/v1/auth/me"), {
			headers: { Authorization: `Bearer ${session.id}` },
		});
		expect(me.status).toBe(200);
	});

	/*
	 * Cloudflare no longer knows the stored secret. Refusing here would refuse
	 * root, with the fix behind the refused sign-in.
	 */
	it("lets requests through when the widget was deleted, so no token comes", async () => {
		await root();
		// A deleted widget renders nothing, so the page sends no token -- and
		// siteverify asked with no token says only that there is none, never
		// that the secret is unknown. That case locked everyone out while the
		// stub answered in a different order from Cloudflare.
		await env.BUCKET.put(
			TURNSTILE_KEY,
			JSON.stringify({ siteKey: SITE, secretKey: "INVALID_SECRET-deleted" }),
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await rootLogin()).status).toBe(200);
		expect(errors).toHaveBeenCalled();
	});

	it("lets requests through when only the secret was rotated", async () => {
		await root();
		// The widget is still there, so a token comes with the request.
		await env.BUCKET.put(
			TURNSTILE_KEY,
			JSON.stringify({ siteKey: SITE, secretKey: "INVALID_SECRET-rotated" }),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await rootLogin("a-token-from-the-widget")).status).toBe(200);
	});
});
