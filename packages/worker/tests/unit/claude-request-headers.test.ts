import { describe, expect, it, vi } from "vitest";
import { classifyWithClaude } from "../../src/claude-spam-filter";

/**
 * What the classifier puts on the wire.
 *
 * Worth its own file because the request went out with three headers --
 * `anthropic-version`, `content-type`, `x-api-key` -- and no `User-Agent` at
 * all, since `fetch` in a Worker sends none unless asked and this is a
 * hand-written call rather than an SDK. Every official SDK sends one.
 *
 * It was added believing it might be the recurring `403 forbidden`: that
 * refusal carried `server=cloudflare cf-ray=...-HKG`, which was read as proof
 * it came from a WAF in front of the API, and a client that will not say who
 * it is scores badly with those. That reading was wrong -- both headers are on
 * every response through api.anthropic.com, including ones the API produced;
 * see answeredBy. The colo in that same string is the better lead, and it is
 * not something a header can change.
 *
 * These assertions stand on their own merits: an HTTP client should identify
 * itself and should say what it accepts, and the failure they guard against is
 * invisible from inside, because the request works everywhere that is not
 * scoring it. None of it is evidence about the 403.
 */

async function headersSent(): Promise<Headers> {
	let sent = new Headers();
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		sent = new Headers(init.headers);
		return new Response(
			JSON.stringify({ content: [{ type: "text", text: " SPAM" }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	try {
		await classifyWithClaude({
			apiKey: "sk-ant-test",
			subject: "subject",
			from: "sender@example.org",
			text: "body",
		});
	} finally {
		vi.unstubAllGlobals();
	}
	return sent;
}

describe("the request the classifier makes", () => {
	it("says who is calling", async () => {
		const sent = await headersSent();
		expect(sent.get("user-agent")).toBe("email-explorer/1");
	});

	it("says what it will accept", async () => {
		const sent = await headersSent();
		expect(sent.get("accept")).toBe("application/json");
	});

	// The three it always had. Adding the two above must not have cost any.
	it("still carries the key, the version and the content type", async () => {
		const sent = await headersSent();
		expect(sent.get("x-api-key")).toBe("sk-ant-test");
		expect(sent.get("anthropic-version")).toBe("2023-06-01");
		expect(sent.get("content-type")).toBe("application/json");
	});

	/**
	 * And the key stays in the one header meant for it. A key that reached a
	 * log or an upstream's diagnostics through the User-Agent would be a worse
	 * problem than the one this is trying to fix.
	 */
	it("keeps the key out of everything else", async () => {
		const sent = await headersSent();
		for (const [name, value] of sent.entries()) {
			if (name === "x-api-key") continue;
			expect([name, value.includes("sk-ant")]).toEqual([name, false]);
		}
	});
});
