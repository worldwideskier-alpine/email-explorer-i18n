import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Where the call to Anthropic leaves from.
 *
 * The second-stage check ran in the `email()` handler. A Worker runs at the
 * Cloudflare data centre that received the message; Email Routing's MX
 * addresses are anycast, so the receiving data centre follows the *sender*.
 * The outbound call therefore left from a different place for every message.
 * Measured on the live mailbox, from the marker recorded on each check:
 *
 *   refused  cf-ray=a354afa3a9618488-HKG  (Hong Kong),  no request-id
 *   worked   cf-ray=a358d46238e9fcd1-FRA  (Frankfurt),  request-id present
 *
 * Two messages to one mailbox, answered on opposite sides of the world. Hong
 * Kong is not on Anthropic's published list of the regions it supports access
 * from; Germany is. So the check was passing or failing according to where
 * the spam had been sent from -- worst for mail from the places whose mail
 * most needs checking, and nothing to do with the key.
 *
 * A Durable Object is a single instance in one place, so calling from there
 * makes the path the same for every message. That is a property of where code
 * runs in production, and **a test cannot observe it**: under
 * @cloudflare/vitest-pool-workers the Durable Object runs in this same
 * isolate, so there is no second location for it to be in. What the tests
 * below can hold is the arrangement that produces it -- that the object does
 * the check, and that the handler asks it rather than doing the call itself.
 * Losing either is how this silently goes back to what it was.
 */

const PASSING_AUTH_RESULTS =
	"mx.example.com; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";

async function receive(subject: string) {
	const worker = await import("../../dev/index");
	const raw = [
		"From: sender@legit.com",
		`To: ${mailboxId}`,
		`Subject: ${subject}`,
		"Content-Type: text/plain",
		`Authentication-Results: ${PASSING_AUTH_RESULTS}`,
		"",
		"Hello",
	].join("\r\n");
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
				lastSuccessVia: string | null;
				lastFailureReason: string | null;
				lastFailureDetail: string | null;
			};
		}>()
	).spamCheck;
}

function mailboxStub() {
	const ns = env.MAILBOX;
	return ns.get(ns.idFromName(mailboxId));
}

describe("the object that makes the call", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	// The check itself, run from the object rather than from the handler.
	it("classifies", async () => {
		const verdict = await mailboxStub().checkSpam({
			apiKey: "sk-ant-test-key",
			subject: "Buy now TRIGGER_CLAUDE_SPAM",
			from: "sender@legit.com",
			text: "body",
		});

		expect(verdict.folder).toBe("spam");
	});

	/**
	 * And records in the same call. These were two calls from the handler --
	 * classify, then record -- which is two chances for the second not to
	 * happen, on the one path whose entire purpose is that a failure gets
	 * noticed. Together they cannot come apart.
	 */
	it("records how it went, without being asked separately", async () => {
		await mailboxStub().checkSpam({
			apiKey: "sk-ant-test-key",
			subject: "Refused TRIGGER_CLAUDE_401",
			from: "sender@legit.com",
			text: "body",
		});

		const after = await health();
		expect(after.lastFailureReason).toBe("unauthorized");
		expect(after.lastFailureDetail).toBe("401 authentication_error");
	});

	// Including the marker that says where the call was answered -- the thing
	// this whole arrangement exists to make constant.
	it("records where a check that worked was answered", async () => {
		await mailboxStub().checkSpam({
			apiKey: "sk-ant-test-key",
			subject: "Fine",
			from: "sender@legit.com",
			text: "body",
		});

		expect((await health()).lastSuccessVia).toContain("cf-ray=");
	});

	// End to end, unchanged from the outside: same verdict, same record.
	it("is what a delivered message goes through", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("Delivered TRIGGER_CLAUDE_SPAM");

		const after = await health();
		expect(after.lastSuccessAt).not.toBeNull();
		expect(after.lastSuccessVia).toContain("cf-ray=");

		const spam = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=spam`,
		);
		expect(
			(await spam.json<{ subject: string }[]>()).some((e) =>
				e.subject.includes("Delivered"),
			),
		).toBe(true);
	});
});

/**
 * That the handler asks the object, rather than making the call itself.
 *
 * Structural, and deliberately so: the difference between the two is which
 * data centre the request leaves from in production, and both run in one
 * isolate here. Every behavioural test above passes just as well with the
 * call moved back into the handler -- which is exactly how it would go back
 * without anyone noticing.
 */
describe("the handler does not make the call itself", () => {
	const sources = import.meta.glob("../../src/*.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>;

	const entry = Object.entries(sources).find(([path]) =>
		path.endsWith("/index.ts"),
	);

	// The glob is the load-bearing part of this file; a rename that made it
	// match nothing would leave the assertions below vacuously passing.
	it("can read the handler's source", () => {
		expect(entry?.[1]?.length ?? 0).toBeGreaterThan(1000);
	});

	it("asks the mailbox object to check", () => {
		expect(entry?.[1]).toContain(".checkSpam({");
	});

	/**
	 * `classifyWithClaude` is still imported here, for the settings screen's
	 * "test this key" button -- which is left in the handler on purpose. That
	 * button answers "is this key valid", and routing it through the object
	 * would mean a deployment whose object sits in a refused region could
	 * never check a key at all. So this counts the calls rather than banning
	 * the import: one is the key check, two would be the classification back
	 * where it started.
	 */
	it("calls the classifier once, and that once is the key check", () => {
		const calls = entry?.[1].match(/\bclassifyWithClaude\(/g) ?? [];
		expect(calls.length).toBe(1);
	});
});
