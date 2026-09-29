import { describe, expect, it } from "vitest";
// Plain JS on purpose: it runs under node in the deploy workflow.
import { withheld } from "../../scripts/log-redaction.mjs";

/**
 * The deploy log is public, and wrangler prints the account's address when a
 * token is refused and the Worker's address when it deploys.
 */
describe("a line of wrangler's output", () => {
	it("loses the account's address", () => {
		const line =
			"✘ [ERROR] A request to the Cloudflare API failed. You are logged in as someone.name+tag@mail.example.co.jp";
		expect(withheld(line)).not.toMatch(/@|example/);
		expect(withheld(line)).toContain("(address withheld)");
	});

	it("loses the Worker's address", () => {
		expect(
			withheld("  https://my-worker.my-subdomain.workers.dev"),
		).not.toContain("workers.dev");
	});

	it("keeps everything else", () => {
		const line = "Current Version ID: 5d405989-868a-4482-b7db-7455cc5f0a0e";
		expect(withheld(line)).toBe(line);
	});
});
