import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { browserSubscription, PUSH_ORIGIN, received } from "./push-reader";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
	userId,
} from "./utils";

/**
 * What a new-mail notification says, read the way a browser reads it.
 *
 * These tests used to point the subscription at a push service that answers
 * 410 and count the subscription gone, which says a notification was sent
 * and nothing about what it said -- the label could have been anything, or
 * missing, and they passed. The push service here keeps what it is sent, and
 * the test holds the subscription's private key, so it decrypts the payload
 * and reads the title.
 */

/** Subscribes the fixture session's browser at a path of its own. */
async function subscribe(path: string) {
	const browser = await browserSubscription();
	const res = await authenticatedFetch(
		"http://local.test/api/v1/push/subscribe",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				endpoint: `${PUSH_ORIGIN}${path}`,
				keys: browser.keys,
			}),
		},
	);
	expect(res.ok).toBe(true);
	// Inside the object rather than over RPC: a statement that fails there
	// over RPC left the runner hanging until the job's timeout.
	const subs = await runInDurableObject(
		env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")),
		(instance) => instance.livePushTargets([userId]),
	);
	expect(subs).toHaveLength(1);
	return browser;
}

async function receive(subject: string) {
	const raw = [
		"From: sender@example.net",
		`To: ${mailboxId}`,
		`Subject: ${subject}`,
		"Content-Type: text/plain",
		`Message-ID: <${crypto.randomUUID()}@example.net>`,
		"",
		"Body text",
	].join("\r\n");
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(raw);
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			rawSize: bytes.length,
			to: mailboxId,
		},
		env,
		createExecutionContext(),
	);
}

describe("New-mail push notification includes the mailbox label", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	it("leads the title with the mailbox's display name when it has one", async () => {
		await createMailbox({ fromName: "受付 Front Desk" });
		const path = `/label/${crypto.randomUUID()}`;
		const browser = await subscribe(path);

		await receive("Mailbox label test");

		const pushes = await received(browser, path);
		expect(pushes).toHaveLength(1);
		expect(pushes[0].title).toBe("[受付 Front Desk] sender@example.net");
		expect(pushes[0].body).toBe("Mailbox label test");
	});

	it("leads the title with the address when there is no display name", async () => {
		await createMailbox();
		const path = `/no-label/${crypto.randomUUID()}`;
		const browser = await subscribe(path);

		await receive("No label test");

		const pushes = await received(browser, path);
		expect(pushes).toHaveLength(1);
		expect(pushes[0].title).toBe(`[${mailboxId}] sender@example.net`);
		expect(pushes[0].body).toBe("No label test");
	});
});
