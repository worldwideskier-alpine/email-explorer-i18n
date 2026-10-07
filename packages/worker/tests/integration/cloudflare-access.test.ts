import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ACCESS_KEY,
	checkAccess,
	forgetAccessState,
} from "../../src/cloudflare-access";
import {
	createDummyMailbox,
	mailboxId,
	sessionToken,
	testAuthBeforeAll,
} from "./utils";

/**
 * The Cloudflare Access signature, checked by the Worker on every request it
 * handles (cloudflare-access.ts). Access stands in front of the deployment;
 * the Worker refuses what Access did not let through, by the token Access
 * signs, once the deploy has written which team is in front
 * (`settings/access.json`, from the redirect the deployment answered it with).
 *
 * Tokens are signed here with the private half of the pool's stand-in key
 * (vitest.config.mts), which the pool hands to any `*.cloudflareaccess.com`
 * team that is asked for its keys.
 */

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-of-this-application";
const NOW = () => Math.floor(Date.now() / 1000);

function base64Url(bytes: Uint8Array | string): string {
	const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(
	claims: Record<string, unknown> = {},
	header: Record<string, unknown> = {},
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"jwk",
		// Bound by the pool's config only; declared on Cloudflare.Env, it made
		// the Durable Object's Env another type, and every runInDurableObject
		// stopped compiling.
		JSON.parse(
			(env as unknown as { TEST_ACCESS_PRIVATE_JWK: string })
				.TEST_ACCESS_PRIVATE_JWK,
		),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const head = base64Url(
		JSON.stringify({ alg: "RS256", kid: "test-access-key", ...header }),
	);
	const body = base64Url(
		JSON.stringify({
			iss: TEAM,
			aud: [AUD],
			exp: NOW() + 3600,
			iat: NOW(),
			email: "someone@example.org",
			...claims,
		}),
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(`${head}.${body}`),
	);
	return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

/** A route that needs no session, so only the Access gate decides. */
const ask = (assertion?: string) =>
	SELF.fetch("http://local.test/api/v1/settings", {
		headers: assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {},
	});

/** What the deploy writes, and what the Worker has made of it since. */
const settle = (value: Record<string, unknown>) =>
	env.BUCKET.put(ACCESS_KEY, JSON.stringify(value));
const stored = async () => {
	const object = await env.BUCKET.get(ACCESS_KEY);
	return object ? await object.json() : null;
};

describe("a deployment the deploy found no Access in front of", () => {
	it("lets every request through, and writes nothing", async () => {
		expect((await ask()).status).toBe(200);
		// Not even a token of a team's own fixes anything: the team is the
		// deploy's to write, never a request's. Learning it from the first
		// token let anybody with a team lock the owner out.
		expect((await ask(await token())).status).toBe(200);
		expect(
			(await ask(await token({ iss: "https://other.cloudflareaccess.com" })))
				.status,
		).toBe(200);
		expect((await ask("garbage")).status).toBe(200);
		expect(await stored()).toBeNull();
	});
});

describe("a deployment with Access in front", () => {
	it("refuses a request with no token", async () => {
		await settle({ issuer: TEAM });
		expect((await ask()).status).toBe(403);
	});

	it("holds every request to the applications the deploy wrote, any one of them", async () => {
		await settle({ issuer: TEAM, audiences: ["workers-dev-app", AUD] });
		expect((await ask(await token())).status).toBe(200);
		expect((await ask(await token({ aud: ["workers-dev-app"] }))).status).toBe(
			200,
		);
		expect((await ask(await token({ aud: ["another-app"] }))).status).toBe(403);
		expect(await stored()).toEqual({
			issuer: TEAM,
			audiences: ["workers-dev-app", AUD],
		});
	});

	it("with none written, fixes the application from the first token its team signed, then holds every request to it", async () => {
		await settle({ issuer: TEAM });
		expect((await ask(await token())).status).toBe(200);
		expect(await stored()).toEqual({ issuer: TEAM, audiences: [AUD] });
		forgetAccessState();
		expect((await ask(await token())).status).toBe(200);
		expect((await ask(await token({ aud: ["another-app"] }))).status).toBe(403);
		expect((await ask()).status).toBe(403);
	});

	it("refuses another team's token without asking that team for its keys", async () => {
		await settle({ issuer: TEAM });
		// The pool's stand-in answers any team with the key that signed this,
		// so only the issuer can refuse it; and a team that does not answer
		// would be a 503 had it been asked.
		expect(
			(await ask(await token({ iss: "https://other.cloudflareaccess.com" })))
				.status,
		).toBe(403);
		expect(
			(await ask(await token({ iss: "https://down.cloudflareaccess.com" })))
				.status,
		).toBe(403);
		expect(await stored()).toEqual({ issuer: TEAM });
	});

	it("takes an audience the token lists among others", async () => {
		await settle({ issuer: TEAM, audiences: [AUD] });
		expect((await ask(await token({ aud: ["x", AUD] }))).status).toBe(200);
		expect((await ask(await token({ aud: AUD }))).status).toBe(200);
	});

	it.each([
		["out of date", { exp: NOW() - 3600 }, {}],
		["not yet in date", { nbf: NOW() + 3600 }, {}],
		[
			"from an issuer that is no Access team",
			{ iss: "https://evil.example" },
			{},
		],
		[
			"from a look-alike issuer",
			{ iss: "https://team.cloudflareaccess.com.evil.example" },
			{},
		],
		["over plain http", { iss: "http://team.cloudflareaccess.com" }, {}],
		["for no audience", { aud: [] }, {}],
		["with no expiry", { exp: undefined }, {}],
		["signed with another algorithm", {}, { alg: "HS256" }],
		["signed with none", {}, { alg: "none" }],
		["signed with a key the team does not publish", {}, { kid: "unknown" }],
	])("refuses a token %s, and fixes nothing", async (_, claims, header) => {
		await settle({ issuer: TEAM });
		expect((await ask(await token(claims, header))).status).toBe(403);
		expect(await stored()).toEqual({ issuer: TEAM });
	});

	it("refuses a token whose signature does not verify", async () => {
		await settle({ issuer: TEAM });
		const good = await token();
		const [head, , signature] = good.split(".");
		const forged = base64Url(
			JSON.stringify({ iss: TEAM, aud: [AUD], exp: NOW() + 3600 }),
		);
		expect((await ask(`${head}.${forged}.${signature}`)).status).toBe(403);
		expect((await ask("not.a.token")).status).toBe(403);
		expect((await ask("garbage")).status).toBe(403);
		expect(await stored()).toEqual({ issuer: TEAM });
	});

	it("answers 503, not 403, when its team's keys cannot be had", async () => {
		await settle({ issuer: "https://down.cloudflareaccess.com" });
		const response = await ask(
			await token({ iss: "https://down.cloudflareaccess.com" }),
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("5");
	});

	it("comes before every route, sign-in and the session gate included", async () => {
		await settle({ issuer: TEAM, audiences: [AUD] });
		const signIn = await SELF.fetch("http://local.test/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "a@example.org", password: "x" }),
		});
		expect(signIn.status).toBe(403);
		const docs = await SELF.fetch("http://local.test/docs");
		expect(docs.status).toBe(403);
	});

	it("does not stand in for a session: Access's token alone reaches no mailbox", async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await settle({ issuer: TEAM, audiences: [AUD] });
		const assertion = await token();
		const without = await SELF.fetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
			{ headers: { "Cf-Access-Jwt-Assertion": assertion } },
		);
		expect(without.status).toBe(401);
		const withSession = await SELF.fetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
			{
				headers: {
					"Cf-Access-Jwt-Assertion": assertion,
					Authorization: `Bearer ${sessionToken}`,
				},
			},
		);
		expect(withSession.status).toBe(200);
	});

	it("leaves mail delivery alone: it is no request", async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await settle({ issuer: TEAM, audiences: [AUD] });
		const worker = await import("../../dev/index");
		const raw = new TextEncoder().encode(
			`From: sender@example.org\r\nTo: ${mailboxId}\r\nSubject: Arrives behind Access\r\n\r\nHello`,
		);
		await worker.default.email(
			{
				raw: new ReadableStream({
					start(controller) {
						controller.enqueue(raw);
						controller.close();
					},
				}),
				rawSize: raw.length,
				to: mailboxId,
			},
			env,
			createExecutionContext(),
		);
		const listed = await SELF.fetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
			{
				headers: {
					"Cf-Access-Jwt-Assertion": await token(),
					Authorization: `Bearer ${sessionToken}`,
				},
			},
		);
		const emails = await listed.json<{ subject: string }[]>();
		expect(emails.map((e) => e.subject)).toContain("Arrives behind Access");
	});

	it("keeps the first application when the first two tokens disagree", async () => {
		await settle({ issuer: TEAM });
		const answers = await Promise.all([
			ask(await token({ aud: ["first-app"] })),
			ask(await token({ aud: ["second-app"] })),
		]);
		const statuses = answers.map((a) => a.status).sort();
		expect(statuses).toEqual([200, 403]);
		const kept = (await stored()) as { audiences: string[] };
		const winner = answers[0]?.status === 200 ? "first-app" : "second-app";
		expect(kept.audiences).toEqual([winner]);
	});

	it("fails closed on settings it cannot read", async () => {
		await env.BUCKET.put(ACCESS_KEY, "{not json");
		expect((await ask()).status).toBe(503);
		expect((await ask(await token())).status).toBe(503);
		forgetAccessState();
		await settle({ issuer: "https://evil.example" });
		expect((await ask()).status).toBe(503);
		forgetAccessState();
		await settle({ issuer: TEAM, audiences: [] });
		expect((await ask()).status).toBe(503);
		forgetAccessState();
		await settle({ issuer: TEAM, audiences: [""] });
		expect((await ask()).status).toBe(503);
	});
});

/**
 * The deploy writes the settings on every run: the team when Access is in
 * front, nothing when it is not. The Worker reads them again after half a
 * minute, so Access turned off stops refusing requests once a deploy has
 * seen it, and an application fixed wrongly is learned again.
 */
describe("what the deploy writes next", () => {
	const plain = () => new Request("http://local.test/api/v1/settings");
	const signed = async () =>
		new Request("http://local.test/api/v1/settings", {
			headers: { "Cf-Access-Jwt-Assertion": await token() },
		});

	it("is read again after half a minute, not before", async () => {
		const at = Date.now();
		await settle({ issuer: TEAM });
		expect((await checkAccess(plain(), env, at)).pass).toBe(false);
		await env.BUCKET.delete(ACCESS_KEY);
		expect((await checkAccess(plain(), env, at + 29_000)).pass).toBe(false);
		expect((await checkAccess(plain(), env, at + 31_000)).pass).toBe(true);
	});

	it("replaces an application learned before, when it names none it is learned again", async () => {
		const at = Date.now();
		await settle({ issuer: TEAM, audiences: ["learned-wrongly"] });
		expect((await checkAccess(await signed(), env, at)).pass).toBe(false);
		await settle({ issuer: TEAM });
		expect((await checkAccess(await signed(), env, at + 31_000)).pass).toBe(
			true,
		);
		expect(await stored()).toEqual({ issuer: TEAM, audiences: [AUD] });
	});
});
