import { describe, expect, it, vi } from "vitest";
import { classifyWithClaude } from "../../src/claude-spam-filter";

/**
 * What the classifier puts on the wire.
 *
 * Worth its own file because of what has been coming back. The refusal that
 * keeps stopping the check now names who issued it -- `403 forbidden
 * [server=cloudflare cf-ray=...-HKG]` -- which is Cloudflare's edge in front
 * of the API rather than the API. That is a bot or WAF decision, and the
 * request being scored went out with three headers: `anthropic-version`,
 * `content-type`, `x-api-key`. No `User-Agent` at all, because `fetch` in a
 * Worker sends none unless asked and this is a hand-written call rather than
 * an SDK.
 *
 * Nothing here proves that caused it. It is the one input to that decision
 * that was measurably wrong on our side, and this file keeps it from
 * regressing silently -- the failure it guards against is invisible from
 * inside: the request still works everywhere that is not scoring it.
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
