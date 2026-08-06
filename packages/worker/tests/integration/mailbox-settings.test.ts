import { describe, expect, it, beforeEach } from "vitest";
import { authenticatedFetch, mailboxId, testAuthBeforeAll } from "./utils";

describe("Mailbox settings: Claude API key redaction", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await authenticatedFetch("http://local.test/api/v1/debug/create-mailbox", { method: "POST" });
	});

	it("never returns the raw key, only whether one is configured", async () => {
		const putResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: { spamFilter: { claudeApiKey: "sk-ant-secret" } },
				}),
			},
		);
		expect(putResponse.status).toBe(200);
		const putBody = await putResponse.json<any>();
		expect(putBody.settings.spamFilter.claudeApiKey).toBeUndefined();
		expect(putBody.settings.spamFilter.claudeApiKeyConfigured).toBe(true);

		const getResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
		);
		const getBody = await getResponse.json<any>();
		expect(getBody.settings.spamFilter.claudeApiKey).toBeUndefined();
		expect(getBody.settings.spamFilter.claudeApiKeyConfigured).toBe(true);
		expect(JSON.stringify(getBody)).not.toContain("sk-ant-secret");
	});

	it("preserves the stored key when saving unrelated settings", async () => {
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: { spamFilter: { claudeApiKey: "sk-ant-secret" } },
			}),
		});

		// Simulate the dashboard saving the signature: it spreads back whatever
		// GetMailbox returned, which never includes the raw key.
		const getResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
		);
		const { settings } = await getResponse.json<any>();
		const putResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: { ...settings, signature: { enabled: true, text: "hi" } },
				}),
			},
		);
		const putBody = await putResponse.json<any>();
		expect(putBody.settings.spamFilter.claudeApiKeyConfigured).toBe(true);
		expect(putBody.settings.signature).toEqual({ enabled: true, text: "hi" });
	});

	it("clears the key when explicitly set to an empty string", async () => {
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: { spamFilter: { claudeApiKey: "sk-ant-secret" } },
			}),
		});

		const putResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: { spamFilter: { claudeApiKey: "" } },
				}),
			},
		);
		const putBody = await putResponse.json<any>();
		expect(putBody.settings.spamFilter.claudeApiKeyConfigured).toBe(false);
	});
});
