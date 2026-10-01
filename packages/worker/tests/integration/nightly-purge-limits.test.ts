import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledBackups, runScheduledSpamPurge } from "./nights";
import { authenticatedFetch, testAuthBeforeAll } from "./utils";

/**
 * The spam purge, held to the same limits the backups were given after the
 * night of 2026-09-22, and the recording after a deadline held to one too.
 *
 * The purge had one limit for a whole mailbox: the pass's deadline. One call
 * that did not answer kept it waiting until then, every mailbox after it went
 * without -- in the order the bucket lists them, so the same ones every night
 * -- and the abandoned purge went on deleting after the pass had moved on.
 * And recording what happened after a deadline was a call of up to a minute
 * per mailbox, with no end: many left over meant as many minutes.
 */

const SLOW = "slow@example.com";
const FINE = "fine@example.com";
const LATER = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const never = <T>() => new Promise<T>(() => {});

async function mailboxWithSpam(id: string, settings: Record<string, unknown>) {
	const made = await authenticatedFetch("http://local.test/api/v1/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: id, name: id }),
	});
	expect(made.status).toBe(201);
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ settings }),
	});
	const raw = [
		"From: s@example.org",
		`To: ${id}`,
		"Subject: spam",
		"",
		"x",
	].join("\r\n");
	const imported = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${id}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder: "spam", rawEmailBase64: btoa(raw) }),
		},
	);
	expect(imported.status).toBe(201);
}

const spamIn = async (id: string) =>
	(await env.MAILBOX.get(env.MAILBOX.idFromName(id)).listSpamEmailDates())
		.length;

/** The mailboxes as the purge sees them, with `slow`'s calls never answering. */
function withSlow(slow: string, asked: string[] = []) {
	const real = env.MAILBOX;
	const slowId = real.idFromName(slow);
	return {
		...env,
		MAILBOX: {
			idFromName: (name: string) => real.idFromName(name),
			get: (id: DurableObjectId) => {
				const stub = real.get(id);
				return new Proxy(stub, {
					get(target, p) {
						if (p === "listSpamEmailDates") {
							return async () => {
								asked.push(id.equals(slowId) ? slow : "other");
								if (id.equals(slowId)) return never();
								return target.listSpamEmailDates();
							};
						}
						return Reflect.get(target, p);
					},
				});
			},
		},
	} as never;
}

const RETENTION = { spamRetention: { enabled: true, days: 1 } };

describe("the spam purge, with one mailbox that does not answer", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await mailboxWithSpam(SLOW, RETENTION);
		await mailboxWithSpam(FINE, RETENTION);
	});

	it("gives up on that one within the call limit, and purges the rest", async () => {
		const started = Date.now();
		const summary = await runScheduledSpamPurge(withSlow(SLOW), LATER, {
			deadline: Date.now() + 60_000,
			callLimitMs: 1000,
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(summary).toMatchObject({ ran: 1, failed: 1 });
		expect(await spamIn(FINE)).toBe(0);
		expect(await spamIn(SLOW)).toBe(1);
	});
});

describe("recording after the backups' deadline", () => {
	const MANY = [
		"a@example.com",
		"b@example.com",
		"c@example.com",
		"d@example.com",
	];

	beforeEach(async () => {
		await testAuthBeforeAll();
		for (const id of MANY) {
			await mailboxWithSpam(id, {
				autoBackup: { enabled: true, frequency: "daily", keep: 5 },
			});
		}
	});

	it("stops when the recording's own end comes, however many are left", async () => {
		// Every write of a mailbox's settings hangs: each "not reached" is a
		// call that waits out its limit.
		const real = env.BUCKET;
		const stuck = new Proxy(real, {
			get(target, p) {
				if (p === "put") {
					return (key: string, ...rest: unknown[]) =>
						key.startsWith("mailboxes/")
							? never()
							: (target.put as (...a: unknown[]) => unknown)(key, ...rest);
				}
				const member = Reflect.get(target, p);
				return typeof member === "function" ? member.bind(target) : member;
			},
		});
		const started = Date.now();
		const summary = await runScheduledBackups(
			{ ...env, BUCKET: stuck } as never,
			new Date(),
			undefined,
			{
				deadline: Date.now() - 1,
				callLimitMs: 2000,
				recordBy: Date.now() + 1500,
			},
		);
		// Four records of up to two seconds each, had they been allowed.
		expect(Date.now() - started).toBeLessThan(5000);
		expect(summary.failed).toBe(MANY.length);
	});
});
