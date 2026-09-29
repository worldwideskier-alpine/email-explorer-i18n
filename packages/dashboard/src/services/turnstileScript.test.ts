import { afterEach, describe, expect, it, vi } from "vitest";
import headers from "../../public/_headers?raw";

/**
 * Turnstile's script: fetched from the one place the page's policy allows,
 * once, and asked for again after a failure rather than failing for good.
 */

const SCRIPT =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const ours = () =>
	[...document.head.querySelectorAll("script")].filter((s) => s.src === SCRIPT);

afterEach(() => {
	for (const s of ours()) s.remove();
	delete window.turnstile;
	vi.resetModules();
});

describe("loading Turnstile", () => {
	it("adds its script once and resolves with what it puts on window", async () => {
		const { loadTurnstile } = await import("./turnstile");
		const first = loadTurnstile();
		const second = loadTurnstile();
		expect(ours()).toHaveLength(1);

		const api = { render: vi.fn(), reset: vi.fn(), remove: vi.fn() };
		window.turnstile = api;
		ours()[0].onload?.(new Event("load"));
		expect(await first).toBe(api);
		expect(await second).toBe(api);
	});

	it("tries again after the script failed to load", async () => {
		const { loadTurnstile } = await import("./turnstile");
		const failed = loadTurnstile();
		ours()[0].onerror?.(new Event("error"));
		await expect(failed).rejects.toThrow("script");

		void loadTurnstile().catch(() => {});
		expect(ours()).toHaveLength(2);
	});
});

describe("the page's policy", () => {
	const policy = /Content-Security-Policy: (.*)/.exec(headers)?.[1] ?? "";
	const directive = (name: string) =>
		policy
			.split(";")
			.map((d) => d.trim())
			.find((d) => d.startsWith(`${name} `)) ?? "";

	it("lets Turnstile's script and frame in", () => {
		expect(directive("script-src").split(" ")).toContain(
			new URL(SCRIPT).origin,
		);
		expect(directive("frame-src").split(" ")).toContain(new URL(SCRIPT).origin);
	});

	it("lets it in nowhere else", () => {
		const elsewhere = policy
			.split(";")
			.map((d) => d.trim())
			.filter((d) => !/^(script|frame)-src /.test(d));
		expect(elsewhere.join(";")).not.toContain("challenges.cloudflare.com");
		expect(directive("script-src")).toBe(
			"script-src 'self' https://challenges.cloudflare.com",
		);
	});
});
