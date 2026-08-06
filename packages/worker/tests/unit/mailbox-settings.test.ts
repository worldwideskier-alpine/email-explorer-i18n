import { describe, expect, it } from "vitest";
import {
	mergeMailboxSettings,
	redactMailboxSettings,
} from "../../src/mailbox-settings";

describe("redactMailboxSettings", () => {
	it("passes through settings with no spamFilter untouched", () => {
		const settings = { signature: { enabled: true, text: "hi" } };
		expect(redactMailboxSettings(settings)).toEqual(settings);
	});

	it("passes through null/undefined", () => {
		expect(redactMailboxSettings(null)).toBeNull();
		expect(redactMailboxSettings(undefined)).toBeUndefined();
	});

	it("strips the raw claudeApiKey and reports it as configured", () => {
		const settings = { spamFilter: { claudeApiKey: "sk-ant-secret" } };
		const result = redactMailboxSettings(settings);
		expect(result?.spamFilter.claudeApiKey).toBeUndefined();
		expect(result?.spamFilter.claudeApiKeyConfigured).toBe(true);
	});

	it("reports claudeApiKeyConfigured as false when there is no key", () => {
		const settings = { spamFilter: {} };
		const result = redactMailboxSettings(settings);
		expect(result?.spamFilter.claudeApiKeyConfigured).toBe(false);
	});
});

describe("mergeMailboxSettings", () => {
	it("preserves the existing key when the incoming payload doesn't touch it", () => {
		const existing = { spamFilter: { claudeApiKey: "sk-ant-secret" } };
		const incoming = {
			signature: { enabled: true, text: "hi" },
			spamFilter: { claudeApiKeyConfigured: true },
		};
		const result = mergeMailboxSettings(existing, incoming);
		expect(result.spamFilter.claudeApiKey).toBe("sk-ant-secret");
		expect(result.signature).toEqual({ enabled: true, text: "hi" });
	});

	it("preserves the existing key when incoming has no spamFilter at all", () => {
		const existing = { spamFilter: { claudeApiKey: "sk-ant-secret" } };
		const incoming = { signature: { enabled: false, text: "" } };
		const result = mergeMailboxSettings(existing, incoming);
		expect(result.spamFilter.claudeApiKey).toBe("sk-ant-secret");
	});

	it("stores a new key when the incoming payload explicitly sets one", () => {
		const existing = { spamFilter: { claudeApiKey: "sk-ant-old" } };
		const incoming = { spamFilter: { claudeApiKey: "sk-ant-new" } };
		const result = mergeMailboxSettings(existing, incoming);
		expect(result.spamFilter.claudeApiKey).toBe("sk-ant-new");
	});

	it("clears the key when the incoming payload explicitly sends an empty string", () => {
		const existing = { spamFilter: { claudeApiKey: "sk-ant-old" } };
		const incoming = { spamFilter: { claudeApiKey: "" } };
		const result = mergeMailboxSettings(existing, incoming);
		expect(result.spamFilter.claudeApiKey).toBeUndefined();
	});

	it("does not invent a spamFilter object when there was never one", () => {
		const incoming = { signature: { enabled: false, text: "" } };
		const result = mergeMailboxSettings(undefined, incoming);
		expect(result.spamFilter).toBeUndefined();
	});
});
