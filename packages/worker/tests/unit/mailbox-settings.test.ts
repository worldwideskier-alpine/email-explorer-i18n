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

	// "Configured" cannot say *which* key, so a key deleted upstream and a
	// working one look identical on the screen. The masked form is what makes
	// the stored key comparable to the ones the API console lists.
	it("says which key is stored, in the console's own format", () => {
		const key = `sk-ant-api03-SCW${"x".repeat(90)}0gAA`;
		const result = redactMailboxSettings({ spamFilter: { claudeApiKey: key } });

		expect(result?.spamFilter.claudeApiKeyMasked).toBe(
			"sk-ant-api03-SCW...0gAA",
		);
		expect(JSON.stringify(result)).not.toContain(key);
	});

	it("has no masked key when there is no key", () => {
		const result = redactMailboxSettings({ spamFilter: {} });
		expect(result?.spamFilter.claudeApiKeyMasked).toBeUndefined();
	});

	// The browser holds the redacted object and sends it back on every save,
	// so a mask stored alongside the key would be handed out again after the
	// key had been replaced -- naming the old key on a screen showing the new.
	it("recomputes the mask rather than trusting a stored one", () => {
		const key = `sk-ant-api03-J7w${"x".repeat(90)}mwAA`;
		const result = redactMailboxSettings({
			spamFilter: {
				claudeApiKey: key,
				claudeApiKeyMasked: "sk-ant-api03-OLD...aaaa",
			},
		});

		expect(result?.spamFilter.claudeApiKeyMasked).toBe(
			"sk-ant-api03-J7w...mwAA",
		);
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

	// Both stand in for the key on the way out and are recomputed from it, so
	// storing what the browser echoes back would leave a copy that is wrong
	// the moment the key changes.
	it("does not store the fields that stand in for the key", () => {
		const existing = { spamFilter: { claudeApiKey: "sk-ant-old" } };
		const incoming = {
			spamFilter: {
				claudeApiKeyConfigured: true,
				claudeApiKeyMasked: "sk-ant-api03-OLD...aaaa",
				claudeApiKey: "sk-ant-new",
			},
		};
		const result = mergeMailboxSettings(existing, incoming);

		expect(result.spamFilter.claudeApiKey).toBe("sk-ant-new");
		expect(Object.hasOwn(result.spamFilter, "claudeApiKeyMasked")).toBe(false);
		expect(Object.hasOwn(result.spamFilter, "claudeApiKeyConfigured")).toBe(
			false,
		);
	});

	it("does not invent a spamFilter object when there was never one", () => {
		const incoming = { signature: { enabled: false, text: "" } };
		const result = mergeMailboxSettings(undefined, incoming);
		expect(result.spamFilter).toBeUndefined();
	});
});

/**
 * The retention count is the one setting that can destroy data, because
 * rotation is the only thing in the application that deletes a backup. If a
 * session could lower it, an attacker holding an administrator's password
 * could empty the archive on the next scheduled run -- which is the whole
 * thing the feature is built to prevent.
 */
describe("mergeMailboxSettings: automatic backup", () => {
	it("lets the retention count rise", () => {
		const merged = mergeMailboxSettings(
			{ autoBackup: { enabled: true, frequency: "daily", keep: 7 } },
			{ autoBackup: { enabled: true, frequency: "daily", keep: 30 } },
		);
		expect(merged.autoBackup.keep).toBe(30);
	});

	it("refuses to let the retention count fall", () => {
		const merged = mergeMailboxSettings(
			{ autoBackup: { enabled: true, frequency: "daily", keep: 30 } },
			{ autoBackup: { enabled: true, frequency: "daily", keep: 1 } },
		);
		expect(merged.autoBackup.keep).toBe(30);
	});

	it("keeps the count when a save does not mention backups at all", () => {
		const merged = mergeMailboxSettings(
			{ autoBackup: { enabled: true, frequency: "weekly", keep: 12 } },
			{ fromName: "Someone" },
		);
		expect(merged.autoBackup).toMatchObject({
			enabled: true,
			frequency: "weekly",
			keep: 12,
		});
	});

	it("lets the frequency and the switch change freely, neither deletes", () => {
		const merged = mergeMailboxSettings(
			{ autoBackup: { enabled: true, frequency: "daily", keep: 5 } },
			{ autoBackup: { enabled: false, frequency: "monthly", keep: 5 } },
		);
		expect(merged.autoBackup).toMatchObject({
			enabled: false,
			frequency: "monthly",
			keep: 5,
		});
	});

	// Otherwise a caller could write a healthy-looking history over a real one.
	it("never takes the record of past runs from the client", () => {
		const merged = mergeMailboxSettings(
			{
				autoBackup: {
					enabled: true,
					keep: 3,
					lastRunAt: "2026-08-01T00:00:00.000Z",
					lastResult: { at: "2026-08-01T00:00:00.000Z", ok: false, error: "x" },
				},
			},
			{
				autoBackup: {
					enabled: true,
					keep: 3,
					lastRunAt: "2026-09-09T00:00:00.000Z",
					lastResult: { at: "2026-09-09T00:00:00.000Z", ok: true },
				},
			},
		);
		expect(merged.autoBackup.lastRunAt).toBe("2026-08-01T00:00:00.000Z");
		expect(merged.autoBackup.lastResult.ok).toBe(false);
	});

	it("clamps a count outside the allowed range", () => {
		expect(
			mergeMailboxSettings({}, { autoBackup: { keep: 99999 } }).autoBackup.keep,
		).toBe(365);
		expect(
			mergeMailboxSettings({}, { autoBackup: { keep: 0 } }).autoBackup.keep,
		).toBe(1);
	});
});
