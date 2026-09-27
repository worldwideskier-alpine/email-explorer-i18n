import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKeyPrefix } from "../../src/auto-backup";
import { runScheduledBackups } from "../../src/backup-run";
import { OutOfTime, within } from "../../src/deadline";
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
const HUNG = "hung@example.com";
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
			lastResult?: { ok: boolean; error?: string };
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
function nightOfTheHang() {
	const aborted: string[] = [];
	const real = (env as unknown as { MAILBOX: DurableObjectNamespace }).MAILBOX;
	const hungId = real.idFromName(HUNG);

	const MAILBOX = {
		idFromName: (name: string) => real.idFromName(name),
		get: (id: DurableObjectId) => {
			const stub = real.get(id) as unknown as Record<
				string,
				(...a: unknown[]) => Promise<unknown>
			>;
			if (!id.equals(hungId)) return stub;
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
			callLimitMs: 200,
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
		// And not counted as done: it is first in line tomorrow.
		expect(hung.autoBackup?.lastRunAt).toBeUndefined();
	});

	// The upload it had begun is aborted, not left open for the bucket to
	// carry until its lifecycle rule gets to it.
	it("aborts the upload it had begun", async () => {
		const night = nightOfTheHang();
		await runScheduledBackups(night.env, NOW, undefined, { callLimitMs: 200 });
		expect(night.aborted).toEqual([
			expect.stringContaining(backupKeyPrefix(HUNG)),
		]);
	});

	it("leaves the night able to finish and say how it went", async () => {
		const night = nightOfTheHang();
		await runScheduledMaintenance(night.env, NOW, { callLimitMs: 200 });

		const record = await readMaintenanceRecord(env as never);
		expect(record?.finishedAt).toBeTypeOf("string");
		expect(record?.backups).toMatchObject({ ran: 1, failed: 1 });
		expect(record?.spamPurge?.finishedAt).toBeTypeOf("string");
	});
});

describe("a pass whose time has run out", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await makeMailbox(HUNG);
		await makeMailbox(FINE);
	});

	it("starts no further mailbox, and says so on each", async () => {
		const summary = await runScheduledBackups(env as never, NOW, undefined, {
			deadline: Date.now() - 1,
		});

		expect(summary).toMatchObject({ ran: 0, failed: 2 });
		for (const id of [HUNG, FINE]) {
			expect(await archivesOf(id)).toEqual([]);
			const settings = await settingsOf(id);
			expect(settings.autoBackup?.lastResult?.error).toContain(
				"ran out of time",
			);
			expect(settings.autoBackup?.lastRunAt).toBeUndefined();
		}
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
