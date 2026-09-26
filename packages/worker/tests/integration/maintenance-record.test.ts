import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	MAINTENANCE_KEY,
	readMaintenanceRecord,
} from "../../src/maintenance-record";
import { runScheduledMaintenance } from "../../src/scheduled-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Whether the nightly run finished, which nothing could say before.
 *
 * Each pass records its outcome on the mailboxes it touched. That answers
 * "did my backup run" and cannot answer "did the run finish": a pass that
 * never started and a pass that ran and found nothing due leave exactly the
 * same absence on every mailbox. In production the backup pass recorded a
 * success at 03:00:38 and the purge recorded nothing at all, ever, and there
 * was no way to tell which of those two it was.
 */

const NOW = new Date("2026-09-02T18:00:00.000Z");
const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;

describe("what the nightly run writes down about itself", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await bucket().delete(MAINTENANCE_KEY);
	});

	it("has nothing to say before the first run", async () => {
		expect(await readMaintenanceRecord(env as never)).toBeNull();
	});

	it("records the start, each pass, and the end", async () => {
		await runScheduledMaintenance(env as never, NOW);

		const record = await readMaintenanceRecord(env as never);
		expect(record?.startedAt).toBe(NOW.toISOString());
		expect(record?.backups?.considered).toBeGreaterThan(0);
		expect(record?.spamPurge?.considered).toBeGreaterThan(0);
		expect(record?.finishedAt).toBeTypeOf("string");
	});

	/**
	 * The case it exists for, and the reason the record is written as the run
	 * goes rather than summarised at the end.
	 *
	 * An invocation that runs out of its budget does not throw -- it stops. So
	 * what it leaves behind is whatever was last written, and that is what is
	 * checked here: every state the record passes through has to be readable
	 * on its own, because any one of them may be the last.
	 */
	it("passes through a state that says where it got to", async () => {
		const written: string[] = [];
		const watched = {
			...(env as unknown as Record<string, unknown>),
			BUCKET: new Proxy(bucket(), {
				get(target, prop) {
					if (prop === "put") {
						return (key: string, body: string, ...rest: unknown[]) => {
							if (key === MAINTENANCE_KEY) written.push(body);
							return (
								target.put as unknown as (...a: unknown[]) => unknown
							).call(target, key, body, ...rest);
						};
					}
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};

		await runScheduledMaintenance(watched as never, NOW);
		const states = written.map((body) => JSON.parse(body));
		expect(states.length).toBeGreaterThanOrEqual(3);

		// Stopped before the backups finished: a beginning and nothing else.
		expect(states[0]).toEqual({ startedAt: NOW.toISOString() });

		// Stopped between the passes -- the production shape, where the backup
		// recorded a success and the purge recorded nothing at all.
		const betweenPasses = states[1];
		expect(betweenPasses.backups?.finishedAt).toBeTypeOf("string");
		expect(betweenPasses.spamPurge).toBeUndefined();
		expect(betweenPasses.finishedAt).toBeUndefined();

		// And the end, which is the only state carrying one.
		expect(states[states.length - 1]?.finishedAt).toBeTypeOf("string");
	});

	// A pass that throws is a different thing from an invocation that stops:
	// the run reached its end, and says what went wrong on the way.
	it("records a pass that threw, and still ends", async () => {
		let listCalls = 0;
		const broken = {
			...(env as unknown as Record<string, unknown>),
			BUCKET: new Proxy(bucket(), {
				get(target, prop) {
					if (prop === "list" && ++listCalls === 2) {
						throw new Error("bucket unavailable");
					}
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};

		await expect(runScheduledMaintenance(broken as never, NOW)).rejects.toThrow(
			"bucket unavailable",
		);

		const record = await readMaintenanceRecord(env as never);
		expect(record?.backups?.finishedAt).toBeTypeOf("string");
		expect(record?.spamPurge?.error).toContain("bucket unavailable");
		expect(record?.finishedAt).toBeTypeOf("string");
	});

	// A run that cannot write its own record must still do its work. The
	// record is a diagnostic; taking the night's backup down for it would be
	// the tail wagging the dog.
	it("still runs when it cannot write the record", async () => {
		const unwritable = {
			...(env as unknown as Record<string, unknown>),
			BUCKET: new Proxy(bucket(), {
				get(target, prop) {
					if (prop === "put") {
						return (key: string, ...rest: unknown[]) => {
							if (key === MAINTENANCE_KEY) {
								return Promise.reject(new Error("read-only"));
							}
							return (
								target.put as unknown as (...a: unknown[]) => unknown
							).call(target, key, ...rest);
						};
					}
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};

		const summary = await runScheduledMaintenance(unwritable as never, NOW);
		expect(summary.backups?.considered).toBeGreaterThan(0);
		expect(summary.spamPurge?.considered).toBeGreaterThan(0);
	});

	it("is root's to read and nobody else's", async () => {
		await runScheduledMaintenance(env as never, NOW);

		// The test session is an ordinary administrator, not root.
		const res = await authenticatedFetch(
			"http://local.test/api/v1/root/maintenance",
		);
		expect(res.status).toBe(403);
	});

	/**
	 * Counts, timestamps, and which mailbox the backup pass had reached --
	 * that last on purpose: it is how a run cut off inside one mailbox is told
	 * from one that never reached the back of the list (MaintenanceProgress).
	 * Nothing of the mail itself: root manages who may sign in and is not a
	 * second pair of eyes on it.
	 *
	 * This used to hold that the record names no mailbox, which it does by
	 * design, and it passed only because no backup was due.
	 */
	it("names nothing in the mail, with a backup due and mail to back up", async () => {
		const subject = "Private subject line";
		const sender = "private.sender@example.org";
		const raw = `From: ${sender}\r\nTo: ${mailboxId}\r\nSubject: ${subject}\r\n\r\nprivate body`;
		const imported = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ folder: "inbox", rawEmailBase64: btoa(raw) }),
			},
		);
		const { id } = await imported.json<{ id: string }>();
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: {
						autoBackup: { enabled: true, frequency: "daily", keep: 3 },
					},
				}),
			},
		);

		const summary = await runScheduledMaintenance(env as never, NOW);
		expect(summary.backups?.ran).toBe(1);

		const text = await (
			(await bucket().get(MAINTENANCE_KEY)) as R2ObjectBody
		).text();
		for (const secret of [subject, sender, id, "private body"]) {
			expect(text).not.toContain(secret);
		}
	});
});
