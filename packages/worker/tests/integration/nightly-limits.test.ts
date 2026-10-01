import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupKeyPrefix } from "../../src/auto-backup";
import { OutOfTime, within } from "../../src/deadline";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";
import { inlineNights } from "../../src/mailbox-night";
import {
	archiveLastRun,
	HISTORY_LENGTH,
	MAINTENANCE_HISTORY_KEY,
	MAINTENANCE_KEY,
	type MaintenanceRecord,
	readMaintenanceHistory,
	readMaintenanceRecord,
} from "../../src/maintenance-record";
import { runScheduledMaintenance } from "../../src/scheduled-run";
import { runScheduledBackups } from "./nights";
import { authenticatedFetch, testAuthBeforeAll } from "./utils";

/**
 * The night of 2026-09-22.
 *
 * The cron ran for 899968 ms, used 716 ms of CPU, and was ended by the
 * runtime as `exceededWallTime`: fourteen minutes of waiting on a call that
 * never answered. Neither mailbox got an archive, the upload each had begun
 * was left open, the spam purge never started -- and the record of the night
 * was replaced by the next night's, so five days later nothing in the
 * deployment could say it had happened.
 *
 * Two things hold here. A call that does not answer costs its mailbox, not
 * the night: the pass gives up on it, aborts the upload, records why, and
 * goes on. And the record of a night is kept for two weeks, so a night that
 * went wrong is still there to be seen.
 */

const NOW = new Date("2026-09-22T18:00:00.000Z");
/**
 * How long a call may take in these tests. It is the one limit for every
 * call, the healthy mailbox's real ones included: at 200 ms those went over
 * it when the whole suite ran at once, and the mailbox that should have been
 * backed up was failed with the hung one. The hung call waits it out either
 * way, so this is also what each such test costs.
 */
const CALL_LIMIT = 1500;
const HUNG = "hung@example.com";
const ALSO_HUNG = "also-hung@example.com";
const FINE = "fine@example.com";

const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const never = <T>() => new Promise<T>(() => {});

async function makeMailbox(id: string) {
	const made = await authenticatedFetch("http://local.test/api/v1/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: id, name: id }),
	});
	expect(made.status, `creating ${id}`).toBe(201);
	const due = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${id}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: {
					autoBackup: { enabled: true, frequency: "daily", keep: 5 },
				},
			}),
		},
	);
	expect(due.status, `turning on backups for ${id}`).toBe(200);
	const raw = [
		"From: sender@example.org",
		`To: ${id}`,
		"Subject: one",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		"body",
	].join("\r\n");
	const imported = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${id}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder: "inbox", rawEmailBase64: btoa(raw) }),
		},
	);
	expect(imported.status, `importing into ${id}`).toBe(201);
}

async function settingsOf(id: string) {
	const stored = await bucket().get(`mailboxes/${id}.json`);
	return (await stored?.json()) as {
		autoBackup?: {
			lastRunAt?: string;
			lastResult?: { ok: boolean; error?: string; reason?: string };
		};
	};
}

async function archivesOf(id: string): Promise<string[]> {
	const listed = await bucket().list({ prefix: backupKeyPrefix(id) });
	return listed.objects.map((o) => o.key);
}

/**
 * The deployment as it was that night: one mailbox whose messages never come
 * back, and a bucket that remembers which uploads were aborted.
 */
function nightOfTheHang(hung: string[] = [HUNG]) {
	const aborted: string[] = [];
	const real = (env as unknown as { MAILBOX: DurableObjectNamespace }).MAILBOX;
	const hungIds = hung.map((name) => real.idFromName(name));

	const MAILBOX = {
		idFromName: (name: string) => real.idFromName(name),
		get: (id: DurableObjectId) => {
			const stub = real.get(id) as unknown as Record<
				string,
				(...a: unknown[]) => Promise<unknown>
			>;
			if (!hungIds.some((h) => id.equals(h))) return stub;
			return {
				listEmailIdsByDate: () => stub.listEmailIdsByDate(),
				getFolders: () => stub.getFolders(),
				getEmailsByIds: () => never(),
			};
		},
	};

	const BUCKET = new Proxy(bucket(), {
		get(target, prop) {
			if (prop === "createMultipartUpload") {
				return async (key: string) => {
					const upload = await target.createMultipartUpload(key);
					return {
						key: upload.key,
						uploadId: upload.uploadId,
						uploadPart: (n: number, part: Uint8Array) =>
							upload.uploadPart(n, part),
						complete: (parts: R2UploadedPart[]) => upload.complete(parts),
						abort: async () => {
							aborted.push(key);
							await upload.abort();
						},
					};
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	return { env: { ...env, MAILBOX, BUCKET } as never, aborted };
}

describe("a call that never answers", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await makeMailbox(HUNG);
		await makeMailbox(FINE);
	});

	it("is given up on, not waited for", async () => {
		await expect(within(never(), 20, "a call")).rejects.toBeInstanceOf(
			OutOfTime,
		);
		// Nothing left at all rejects at once rather than after a timer.
		await expect(within(never(), 0, "a call")).rejects.toThrow(
			"a call did not answer within 0s",
		);
	});

	it("fails its own mailbox, and the next one is still backed up", async () => {
		const night = nightOfTheHang();
		const summary = await runScheduledBackups(night.env, NOW, undefined, {
			callLimitMs: CALL_LIMIT,
		});

		expect(summary).toMatchObject({ ran: 1, failed: 1 });
		expect(await archivesOf(HUNG)).toEqual([]);
		expect(await archivesOf(FINE)).toHaveLength(1);

		// Why, where the mailbox's own screen shows it.
		const hung = await settingsOf(HUNG);
		expect(hung.autoBackup?.lastResult?.ok).toBe(false);
		expect(hung.autoBackup?.lastResult?.error).toContain(
			"reading messages from the mailbox did not answer",
		);
		// A call that hung is not a pass that ran out of time.
		expect(hung.autoBackup?.lastResult?.reason).toBeUndefined();
		// And not counted as done: it is first in line tomorrow.
		expect(hung.autoBackup?.lastRunAt).toBeUndefined();
	});

	// The upload it had begun is aborted, not left open for the bucket to
	// carry until its lifecycle rule gets to it.
	it("aborts the upload it had begun", async () => {
		const night = nightOfTheHang();
		await runScheduledBackups(night.env, NOW, undefined, {
			callLimitMs: CALL_LIMIT,
		});
		expect(night.aborted).toEqual([
			expect.stringContaining(backupKeyPrefix(HUNG)),
		]);
	});

	it("leaves the night able to finish and say how it went", async () => {
		const night = nightOfTheHang();
		await runScheduledMaintenance(night.env, NOW, {
			nights: inlineNights,
			callLimitMs: CALL_LIMIT,
			pollMs: 20,
		});

		const record = await readMaintenanceRecord(env as never);
		expect(record?.finishedAt).toBeTypeOf("string");
		expect(record?.backups).toMatchObject({ ran: 1, failed: 1 });
		expect(record?.spamPurge?.finishedAt).toBeTypeOf("string");
	});
});

/**
 * The night of 2026-10-01: the second mailbox's backup was slow, not hung,
 * and reached the pass's end 300 messages in. Its next call was given the
 * seven seconds that were left, and the record said "did not answer within
 * 7s" -- which reads as a broken call. Cut off by the pass's end, it says so.
 */
describe("a backup stopped by the pass's end", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await makeMailbox(HUNG);
	});

	it("is recorded as out of time, not as a call that did not answer", async () => {
		const night = nightOfTheHang();
		await runScheduledBackups(night.env, NOW, undefined, {
			deadline: Date.now() + CALL_LIMIT,
			callLimitMs: 60_000,
		});

		const result = (await settingsOf(HUNG)).autoBackup?.lastResult;
		expect(result?.ok).toBe(false);
		expect(result?.reason).toBe("out-of-time");
		expect(result?.error).toContain("ran out of time while");
		expect(result?.error).not.toContain("did not answer");
	});
});

/**
 * An archive completed as the pass's time ran out.
 *
 * Removing the old archives came after the upload was completed and was held
 * to the deadline too, so with no time left it was refused at once -- and the
 * mailbox was recorded as failed, and not counted as done, with tonight's
 * archive sitting in the bucket.
 */
describe("an archive finished as the time runs out", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await makeMailbox(FINE);
	});

	it("is recorded as the backup it is", async () => {
		const realNow = Date.now.bind(Date);
		let late = 0;
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementation(() => realNow() + late);
		const BUCKET = new Proxy(bucket(), {
			get(target, prop) {
				if (prop === "createMultipartUpload") {
					return async (key: string) => {
						const upload = await target.createMultipartUpload(key);
						return {
							key: upload.key,
							uploadId: upload.uploadId,
							uploadPart: (n: number, part: Uint8Array) =>
								upload.uploadPart(n, part),
							complete: async (parts: R2UploadedPart[]) => {
								const done = await upload.complete(parts);
								// The deadline passes the moment the archive is whole.
								late = 120_000;
								return done;
							},
							abort: () => upload.abort(),
						};
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		try {
			const summary = await runScheduledBackups(
				{ ...env, BUCKET } as never,
				NOW,
				undefined,
				{ deadline: Date.now() + 60_000 },
			);
			expect(summary).toMatchObject({ ran: 1, failed: 0 });
		} finally {
			clock.mockRestore();
		}
		expect(await archivesOf(FINE)).toHaveLength(1);
		const settings = await settingsOf(FINE);
		expect(settings.autoBackup?.lastResult?.ok).toBe(true);
		expect(settings.autoBackup?.lastRunAt).toBe(NOW.toISOString());
	});
});

/**
 * A mailbox that takes the whole of its time.
 *
 * Every mailbox used to be one turn in a single pass, so one that could not
 * finish spent the time of the ones behind it: on 2026-10-01 the second of
 * two was cut off 300 messages in. Each mailbox's night now runs on its own
 * (mailbox-night.ts), so the one that never answers runs out its own time
 * and the other is backed up the same night, in its own.
 */
describe("a mailbox that takes the whole of its time", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await makeMailbox(HUNG);
		await makeMailbox(ALSO_HUNG);
		await makeMailbox(FINE);
	});

	it("does not take the other mailbox's night with it", async () => {
		const hang = nightOfTheHang([HUNG, ALSO_HUNG]);
		const started = Date.now();
		const summary = await runScheduledMaintenance(hang.env, NOW, {
			nights: inlineNights,
			backupByMs: 2000,
			purgeByMs: 2500,
			recordByMs: 3000,
			callLimitMs: 60_000,
			pollMs: 20,
		});

		// All at once: two mailboxes that each take their whole two seconds
		// are done in about two seconds, not four. One after another, the
		// second would have started where the first ran out.
		expect(Date.now() - started).toBeLessThan(3800);
		expect(summary.backups).toMatchObject({ ran: 1, failed: 2 });
		expect(await archivesOf(FINE)).toHaveLength(1);
		for (const id of [HUNG, ALSO_HUNG]) {
			const hung = (await settingsOf(id)).autoBackup?.lastResult;
			expect(hung?.ok, id).toBe(false);
			expect(hung?.reason, id).toBe("out-of-time");
		}
		expect(hang.aborted.sort()).toEqual([
			expect.stringContaining(backupKeyPrefix(ALSO_HUNG)),
			expect.stringContaining(backupKeyPrefix(HUNG)),
		]);
	}, 20_000);
});

/**
 * The scheduled handler itself, not only the passes it runs.
 *
 * It used to await the legacy grant backfill first -- two calls to the auth
 * object, with no limit and before the night's record existed. An auth object
 * that did not answer held the invocation until the runtime ended it, with
 * nothing written: the night of 2026-09-22 by another road.
 */
describe("the scheduled handler", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await makeMailbox(FINE);
		await bucket().delete(MAINTENANCE_KEY);
		resetLegacyGrantMemo();
	});

	it("finishes the night when the auth object never answers", async () => {
		const real = env.MAILBOX;
		const authId = real.idFromName("AUTH");
		const hungAuth = new Proxy(
			{},
			{ get: (_t, prop) => (prop === "then" ? undefined : () => never()) },
		);
		const MAILBOX = {
			idFromName: (name: string) => real.idFromName(name),
			get: (id: DurableObjectId) =>
				id.equals(authId) ? hungAuth : real.get(id),
		};
		const worker = await import("../../dev/index");

		const outcome = await Promise.race([
			worker.default
				.scheduled(
					{ cron: "0 18 * * *", scheduledTime: Date.now() },
					{ ...env, MAILBOX } as never,
					createExecutionContext(),
				)
				.then(() => "finished"),
			new Promise((resolve) => setTimeout(() => resolve("held"), 3000)),
		]);

		expect(outcome).toBe("finished");
		const record = await readMaintenanceRecord(env as never);
		expect(record?.finishedAt).toBeTypeOf("string");
		expect(await archivesOf(FINE)).toHaveLength(1);
	});
});

describe("the record of earlier nights", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await bucket().delete(MAINTENANCE_KEY);
		await bucket().delete(MAINTENANCE_HISTORY_KEY);
	});

	/** Exactly what the runtime left behind on 2026-09-22. */
	const cutOff: MaintenanceRecord = {
		startedAt: "2026-09-22T18:00:53.757Z",
		backupProgress: { mailbox: FINE, index: 2, of: 2, messages: 0 },
	};

	it("keeps a night that never reached its end, when the next one starts", async () => {
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(cutOff));

		await runScheduledMaintenance(
			env as never,
			new Date("2026-09-23T18:00:00.000Z"),
		);

		expect(await readMaintenanceHistory(env as never)).toEqual([cutOff]);
		const tonight = await readMaintenanceRecord(env as never);
		expect(tonight?.startedAt).toBe("2026-09-23T18:00:00.000Z");
	});

	it("puts the newest first and keeps two weeks", async () => {
		const older = Array.from({ length: HISTORY_LENGTH }, (_, i) => ({
			startedAt: `2026-09-${String(20 - i).padStart(2, "0")}T18:00:00.000Z`,
			finishedAt: `2026-09-${String(20 - i).padStart(2, "0")}T18:06:00.000Z`,
		}));
		await bucket().put(MAINTENANCE_HISTORY_KEY, JSON.stringify(older));
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(cutOff));

		await archiveLastRun(env as never);

		const history = await readMaintenanceHistory(env as never);
		expect(history).toHaveLength(HISTORY_LENGTH);
		expect(history[0]).toEqual(cutOff);
		expect(history[1]).toEqual(older[0]);
		expect(history).not.toContainEqual(older[HISTORY_LENGTH - 1]);
	});

	it("does not keep the same night twice", async () => {
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(cutOff));
		await archiveLastRun(env as never);
		await archiveLastRun(env as never);
		expect(await readMaintenanceHistory(env as never)).toEqual([cutOff]);
	});

	it("is empty, not an error, before there is any", async () => {
		expect(await readMaintenanceHistory(env as never)).toEqual([]);
		await bucket().put(MAINTENANCE_HISTORY_KEY, "not json");
		expect(await readMaintenanceHistory(env as never)).toEqual([]);
	});

	it("is root's to read and nobody else's", async () => {
		const res = await authenticatedFetch(
			"http://local.test/api/v1/root/maintenance/history",
		);
		expect(res.status).toBe(403);
	});
});
