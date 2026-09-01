import { describe, expect, it, beforeEach } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

describe("Mailbox settings: Claude API key redaction", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
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

	/**
	 * Which key, over the real route. The screen used to say only that one was
	 * stored, so a key deleted in the API console and a working one produced
	 * the same green badge, and the only way to find out which was in there was
	 * to overwrite it and wait for the next message to arrive.
	 */
	it("names the stored key the way its console lists it", async () => {
		const key = `sk-ant-api03-SCW${"x".repeat(90)}0gAA`;
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { spamFilter: { claudeApiKey: key } } }),
		});

		const first = await (
			await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`)
		).json<any>();
		expect(first.settings.spamFilter.claudeApiKeyMasked).toBe(
			"sk-ant-api03-SCW...0gAA",
		);
		expect(JSON.stringify(first)).not.toContain(key);

		// Replacing the key the way the screen does -- spreading back the
		// redacted object it holds, with a new key in it. The mask that came
		// with that object must not survive as the answer to "which key".
		const replacement = `sk-ant-api03-J7w${"x".repeat(90)}mwAA`;
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: {
					...first.settings,
					spamFilter: {
						...first.settings.spamFilter,
						claudeApiKey: replacement,
					},
				},
			}),
		});

		const second = await (
			await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`)
		).json<any>();
		expect(second.settings.spamFilter.claudeApiKeyMasked).toBe(
			"sk-ant-api03-J7w...mwAA",
		);
		expect(JSON.stringify(second)).not.toContain(replacement);
	});

	it("shows no key once it is removed", async () => {
		const key = `sk-ant-api03-SCW${"x".repeat(90)}0gAA`;
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { spamFilter: { claudeApiKey: key } } }),
		});
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { spamFilter: { claudeApiKey: "" } } }),
		});

		const body = await (
			await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`)
		).json<any>();
		expect(body.settings.spamFilter.claudeApiKeyConfigured).toBe(false);
		expect(body.settings.spamFilter.claudeApiKeyMasked).toBeUndefined();
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
		await createDummyMailbox();
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
