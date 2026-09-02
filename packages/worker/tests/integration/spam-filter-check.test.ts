import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Putting the stored key to the API on demand.
 *
 * Before this, the only thing that ever exercised a key was inbound mail, so
 * the answer to "does this key work?" arrived whenever the next message did --
 * hours, on a quiet mailbox. Saving a key the API refuses looked exactly like
 * saving one that works, and the badge stayed green in between.
 */

const check = () =>
	authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/spam-filter/check`,
		{ method: "POST" },
	);

async function setClaudeApiKey(apiKey: string) {
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			settings: { spamFilter: { claudeApiKey: apiKey } },
		}),
	});
}

async function health() {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}`,
	);
	return (
		await res.json<{
			spamCheck: {
				lastSuccessAt: string | null;
				lastFailureAt: string | null;
				lastFailureReason: string | null;
			};
		}>()
	).spamCheck;
}

describe("checking the stored key against the API", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("says the key works when the API accepts it", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		const res = await check();
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
	});

	// The whole point: the reason and the line beside it, in the same shape
	// the health line uses, so the screen can say the same thing about both.
	it("reports a refusal the way a failed check is reported", async () => {
		await setClaudeApiKey("sk-ant-TRIGGER_CLAUDE_403");

		const body = await (await check()).json<{
			ok: boolean;
			failure?: string;
			detail?: string;
		}>();
		expect(body).toEqual({
			ok: false,
			failure: "forbidden",
			detail: "403 permission_error",
		});
	});

	it("separates a rejected key from a key refused permission", async () => {
		await setClaudeApiKey("sk-ant-TRIGGER_CLAUDE_401");
		expect(await (await check()).json()).toMatchObject({
			ok: false,
			failure: "unauthorized",
			detail: "401 authentication_error",
		});
	});

	/**
	 * Deliberately not written into spam_check_health. That line is the
	 * history of what happened to actual mail, and it is what a standing
	 * warning is drawn from -- so a manual test recorded there would clear the
	 * warning without a single message having been classified, which is the
	 * exact failing the health line exists to correct.
	 */
	it("leaves the record of what happened to real mail alone", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		const before = await health();

		expect(await (await check()).json()).toMatchObject({ ok: true });
		expect(await health()).toEqual(before);

		await setClaudeApiKey("sk-ant-TRIGGER_CLAUDE_403");
		await check();
		expect(await health()).toEqual(before);
	});

	it("has nothing to check when no key is stored", async () => {
		const res = await check();
		expect(res.status).toBe(404);
	});

	it("has nothing to check once the key is removed", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await setClaudeApiKey("");
		expect((await check()).status).toBe(404);
	});

	// It reads a stored secret and spends someone's quota, so it is behind the
	// same two gates every other mailbox route is.
	it("needs a session", async () => {
		const res = await SELF.fetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/spam-filter/check`,
			{ method: "POST" },
		);
		expect(res.status).toBe(401);
	});

	it("refuses a mailbox that is not this person's", async () => {
		const res = await authenticatedFetch(
			"http://local.test/api/v1/mailboxes/nobody@example.com/spam-filter/check",
			{ method: "POST" },
		);
		expect(res.status).toBe(403);
	});
});
