import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCESS_KEY } from "../../src/cloudflare-access";
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
 * signs, once it has learned which team and application are its own.
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

const pinned = async () => {
	const object = await env.BUCKET.get(ACCESS_KEY);
	return object ? await object.json() : null;
};

describe("the Access signature", () => {
	it("lets a deployment without Access through, and pins nothing", async () => {
		expect((await ask()).status).toBe(200);
		expect(await pinned()).toBeNull();
	});

	it("pins the team and application of the first token, then holds every request to them", async () => {
		expect((await ask(await token())).status).toBe(200);
		expect(await pinned()).toEqual({ issuer: TEAM, audience: AUD });

		expect((await ask(await token())).status).toBe(200);
		// From here a request Access did not sign is refused.
		expect((await ask()).status).toBe(403);
		expect((await ask(await token({ aud: ["another-app"] }))).status).toBe(403);
		expect(
			(await ask(await token({ iss: "https://other.cloudflareaccess.com" })))
				.status,
		).toBe(403);
	});

	it("takes an audience the token lists among others", async () => {
		await ask(await token());
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
	])("refuses a token %s, and pins nothing", async (_, claims, header) => {
		expect((await ask(await token(claims, header))).status).toBe(403);
		expect(await pinned()).toBeNull();
	});

	it("refuses a token whose signature does not verify", async () => {
		const good = await token();
		const [head, , signature] = good.split(".");
		const forged = base64Url(
			JSON.stringify({ iss: TEAM, aud: [AUD], exp: NOW() + 3600 }),
		);
		expect((await ask(`${head}.${forged}.${signature}`)).status).toBe(403);
		expect((await ask("not.a.token")).status).toBe(403);
		expect((await ask("garbage")).status).toBe(403);
		expect(await pinned()).toBeNull();
	});

	it("answers 503, not 403, when the team's keys cannot be had", async () => {
		const response = await ask(
			await token({ iss: "https://down.cloudflareaccess.com" }),
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("5");
	});

	it("comes before every route, sign-in and the session gate included", async () => {
		await ask(await token());
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
		await ask(await token());
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

	it("pins once when the first two tokens arrive together", async () => {
		const [a, b] = await Promise.all([ask(await token()), ask(await token())]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(await pinned()).toEqual({ issuer: TEAM, audience: AUD });
	});

	it("keeps the first pin when two first tokens disagree", async () => {
		const answers = await Promise.all([
			ask(await token({ aud: ["first-app"] })),
			ask(await token({ aud: ["second-app"] })),
		]);
		const statuses = answers.map((a) => a.status).sort();
		expect(statuses).toEqual([200, 403]);
		const kept = (await pinned()) as { audience: string };
		const winner = answers[0]?.status === 200 ? "first-app" : "second-app";
		expect(kept.audience).toBe(winner);
	});

	it("fails closed on a pin it cannot read", async () => {
		await env.BUCKET.put(ACCESS_KEY, "{not json");
		expect((await ask()).status).toBe(503);
		expect((await ask(await token())).status).toBe(503);
	});
});
