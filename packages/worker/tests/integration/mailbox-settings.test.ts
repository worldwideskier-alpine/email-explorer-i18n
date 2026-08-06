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

describe("Mailbox settings: display name (fromName)", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await authenticatedFetch("http://local.test/api/v1/debug/create-mailbox", { method: "POST" });
	});

	it("GetMailbox returns the stored fromName as the display name", async () => {
		// CreateDummyMailbox seeds fromName: "Test User" -- see debug route.
		const res = await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`);
		const body = await res.json<any>();
		expect(body.name).toBe("Test User");
	});

	it("GetMailboxes lists the stored fromName as the display name", async () => {
		const res = await authenticatedFetch("http://local.test/api/v1/mailboxes");
		const body = await res.json<any[]>();
		const mailbox = body.find((m) => m.id === mailboxId);
		expect(mailbox?.name).toBe("Test User");
	});

	it("PutMailbox persists a new name and it survives a subsequent GET", async () => {
		const getResponse = await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`);
		const { settings } = await getResponse.json<any>();

		const putResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings: { ...settings, fromName: "New Name" } }),
			},
		);
		const putBody = await putResponse.json<any>();
		expect(putBody.name).toBe("New Name");

		const res = await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`);
		const body = await res.json<any>();
		expect(body.name).toBe("New Name");

		const listRes = await authenticatedFetch("http://local.test/api/v1/mailboxes");
		const listBody = await listRes.json<any[]>();
		expect(listBody.find((m) => m.id === mailboxId)?.name).toBe("New Name");
	});

	it("falls back to the mailbox id when fromName is empty", async () => {
		const getResponse = await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`);
		const { settings } = await getResponse.json<any>();

		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { ...settings, fromName: "" } }),
		});

		const res = await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`);
		const body = await res.json<any>();
		expect(body.name).toBe(mailboxId);
	});
});
