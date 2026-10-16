import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKeyPrefix } from "../../src/auto-backup";
import {
	abandonPausedBackup,
	stepMailboxBackup,
} from "../../src/backup-writer";
import {
	finishUnfinishedDeletions,
	UNFINISHED_DELETIONS_KEY,
} from "../../src/mailbox-destroy";
import type { NightRunner } from "../../src/mailbox-night";
import { inlineNights } from "../../src/mailbox-night";
import {
	archiveLastRun,
	HISTORY_LENGTH,
	MAINTENANCE_HISTORY_KEY,
	MAINTENANCE_KEY,
	readMaintenanceHistory,
	readMaintenanceRecord,
} from "../../src/maintenance-record";
import { rewriteJson } from "../../src/r2-json";
import { getBytes, readRetrying } from "../../src/r2-retry";
import { runScheduledMaintenance } from "../../src/scheduled-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const stub = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

const slowDown = () =>
	Object.assign(
		new Error(
			"get: Reduce your rate of simultaneous reads on the same object. (10058)",
		),
		{ code: 10058 },
	);

/**
 * The bucket, with `fail(key, n)` deciding which gets throw what -- and, for
 * `"body"`, which come back with a body that will not read.
 */
function failing(fail: (key: string, n: number) => Error | "body" | null) {
	const seen = new Map<string, number>();
	const proxied = new Proxy(bucket(), {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (prop === "get") {
				return async (key: string, ...rest: unknown[]) => {
					const n = (seen.get(key) ?? 0) + 1;
					seen.set(key, n);
					const error = fail(key, n);
					if (error === "body") {
						const real = (await (value as (...a: unknown[]) => unknown).call(
							target,
							key,
							...rest,
						)) as R2ObjectBody | null;
						if (!real) return real;
						const broken = () =>
							Promise.reject(new Error("Network connection lost."));
						return Object.assign(Object.create(real), {
							json: broken,
							text: broken,
							arrayBuffer: broken,
						});
					}
					if (error) throw error;
					return (value as (...a: unknown[]) => unknown).call(
						target,
						key,
						...rest,
					);
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		env: { ...(env as unknown as Record<string, unknown>), BUCKET: proxied },
		seen,
	};
}

async function seed(count: number, bytesEach = 200 * 1024) {
	const line =
		"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2";
	const body = Array.from(
		{ length: Math.ceil(bytesEach / (line.length + 2)) },
		() => line,
	).join("\r\n");
	const mailbox = stub() as unknown as {
		createEmail: (f: string, e: object, a: unknown[]) => Promise<unknown>;
	};
	for (let i = 0; i < count; i++) {
		const id = `m${String(i).padStart(3, "0")}`;
		await bucket().put(
			`raw/${id}.eml`,
			`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: s${i}\r\n\r\n${body}\r\n`,
		);
		await mailbox.createEmail(
			"inbox",
			{
				id,
				subject: `s${i}`,
				sender: "a@example.org",
				recipient: mailboxId,
				date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
				body: "b",
			},
			[],
		);
	}
}

async function settings() {
	const object = (await bucket().get(
		`mailboxes/${mailboxId}.json`,
	)) as R2ObjectBody;
	return object.json<{
		autoBackup?: {
			lastResult?: { ok: boolean; messages?: number; error?: string };
		};
	}>();
}

async function carried() {
	const listed = await bucket().list({ prefix: "backup-carry/" });
	return listed.objects.map((o) => o.key);
}

async function archives() {
	const listed = await bucket().list({ prefix: backupKeyPrefix(mailboxId) });
	return listed.objects.map((o) => o.key);
}

describe("R2 asking a read to slow down", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: {
						autoBackup: { enabled: true, frequency: "daily", keep: 7 },
					},
				}),
			},
		);
		expect(res.status).toBe(200);
		await seed(15);
	});

	it("costs a message's original two tries, not the night's archive", async () => {
		const night = failing((key, n) =>
			key === "raw/m005.eml" && n <= 2 ? slowDown() : null,
		);
		const summary = await runScheduledMaintenance(
			night.env as never,
			new Date(),
			{ nights: inlineNights, pollMs: 20 },
		);
		expect(summary.backups).toMatchObject({ ran: 1, failed: 0 });
		expect(night.seen.get("raw/m005.eml")).toBe(3);
		expect((await settings()).autoBackup?.lastResult).toMatchObject({
			ok: true,
			messages: 15,
		});
		expect(await archives()).toHaveLength(1);
	}, 30_000);

	it("costs a paused backup's place one try, not the night's archive", async () => {
		const night = failing((key, n) =>
			key.startsWith("backup-carry/") && key.endsWith(".json") && n === 1
				? slowDown()
				: null,
		);
		const summary = await runScheduledMaintenance(
			night.env as never,
			new Date(),
			{ nights: inlineNights, pollMs: 20, sliceBytes: 1 },
		);
		expect(summary.backups).toMatchObject({ ran: 1, failed: 0 });
		expect((await settings()).autoBackup?.lastResult?.ok).toBe(true);
	}, 30_000);

	it("keeps why a backup failed in the run's record, with what it was doing", async () => {
		const night = failing((key) =>
			key === "raw/m005.eml"
				? Object.assign(
						new Error("get: We encountered an internal error. (10001)"),
						{
							code: 10001,
						},
					)
				: null,
		);
		const summary = await runScheduledMaintenance(
			night.env as never,
			new Date(),
			{ nights: inlineNights, pollMs: 20 },
		);
		expect(summary.backups).toMatchObject({ ran: 0, failed: 1 });
		// Not tried again: only "slow down" is.
		expect(night.seen.get("raw/m005.eml")).toBe(1);
		const record = await readMaintenanceRecord(env as never);
		// What it was doing and which kind of object, never which one.
		expect(record?.backups?.reasons).toEqual([
			"reading messages' originals and attachments: raw/…: get: We encountered an internal error. (10001)",
		]);
	}, 30_000);

	// Nothing starts without the list: one refusal here failed every night.
	it("costs the mailbox list a try, not the whole night", async () => {
		const night = failing((key, n) =>
			key === `mailboxes/${mailboxId}.json` && n === 1 ? slowDown() : null,
		);
		const summary = await runScheduledMaintenance(
			night.env as never,
			new Date(),
			{ nights: inlineNights, pollMs: 20 },
		);
		expect(summary.backups).toMatchObject({ ran: 1, failed: 0 });
		expect(summary.backups?.considered).toBeGreaterThan(0);
		const record = await readMaintenanceRecord(env as never);
		expect(record?.backups?.error).toBeUndefined();
	}, 30_000);
});

describe("why a night failed, when the night never said", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: {
						autoBackup: { enabled: true, frequency: "daily", keep: 7 },
					},
				}),
			},
		);
		expect(res.status).toBe(200);
	});

	it("says it could not be started, and why", async () => {
		const nights = (): NightRunner => ({
			start: async () => {
				throw new Error("the mailbox's object did not answer");
			},
			status: async () => null,
		});
		await runScheduledMaintenance(env as never, new Date(), {
			nights,
			pollMs: 20,
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.backups).toMatchObject({ ran: 0, failed: 1 });
		expect(record?.backups?.reasons).toEqual([
			"Could not be started: the mailbox's object did not answer",
		]);
	}, 30_000);

	// What the second call saw on 2026-10-13, for fourteen minutes.
	it("says it was never seen to begin", async () => {
		const nights = (): NightRunner => ({
			start: async () => {},
			status: async () => null,
		});
		await runScheduledMaintenance(env as never, new Date(), {
			nights,
			pollMs: 20,
			waitByMs: 500,
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.backups).toMatchObject({ ran: 0, failed: 1 });
		expect(record?.backups?.reasons).toEqual([
			"The mailbox's night was never seen to begin.",
		]);
	}, 30_000);
});

describe("the history of earlier nights, when a read fails", () => {
	const last = {
		startedAt: "2026-10-14T18:00:00.000Z",
		finishedAt: "2026-10-14T18:06:00.000Z",
	};
	const older = Array.from({ length: HISTORY_LENGTH }, (_, i) => ({
		startedAt: `2026-09-${String(30 - i).padStart(2, "0")}T18:00:00.000Z`,
		finishedAt: `2026-09-${String(30 - i).padStart(2, "0")}T18:06:00.000Z`,
	}));

	beforeEach(async () => {
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(last));
		await bucket().put(MAINTENANCE_HISTORY_KEY, JSON.stringify(older));
	});

	it("still takes last night in when R2 asks to slow down", async () => {
		const night = failing((key, n) =>
			key === MAINTENANCE_HISTORY_KEY && n === 1 ? slowDown() : null,
		);
		await archiveLastRun(night.env as never, "2026-10-15T18:00:00.000Z");
		const history = await readMaintenanceHistory(env as never);
		expect(history[0]).toEqual(last);
		expect(history).toHaveLength(HISTORY_LENGTH);
	});

	it("is not put back as one night when it could not be read", async () => {
		const night = failing((key) =>
			key === MAINTENANCE_HISTORY_KEY ? "body" : null,
		);
		await expect(
			archiveLastRun(night.env as never, "2026-10-15T18:00:00.000Z"),
		).rejects.toThrow();
		expect(await readMaintenanceHistory(env as never)).toEqual(older);
	});
});

describe("the night's other reads, when R2 asks to slow down", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await seed(15);
	});

	it("still gives up a paused backup, upload and all", async () => {
		const paused = await stepMailboxBackup(
			env as never,
			mailboxId,
			new Date(),
			7,
			undefined,
			undefined,
			{},
			undefined,
			{ bytes: 1, until: Date.now() + 60_000 },
		);
		expect(paused.kind).toBe("paused");
		expect(await carried()).toHaveLength(2);
		const night = failing((key, n) =>
			key.startsWith("backup-carry/") && key.endsWith(".json") && n === 1
				? slowDown()
				: null,
		);
		await abandonPausedBackup(night.env as never, mailboxId);
		expect(await carried()).toEqual([]);
	});

	it("still reads the deletions left unfinished", async () => {
		await bucket().put(UNFINISHED_DELETIONS_KEY, JSON.stringify([]));
		const night = failing((key, n) =>
			key === UNFINISHED_DELETIONS_KEY && n === 1 ? slowDown() : null,
		);
		await expect(
			finishUnfinishedDeletions(night.env as never),
		).resolves.toEqual({ finished: 0, left: 0 });
	});
});

describe("a rewrite of a JSON object R2 asks to slow down", () => {
	it("reads again and writes", async () => {
		const night = failing((key, n) =>
			key === "settings/x.json" && n === 1 ? slowDown() : null,
		);
		await bucket().put("settings/x.json", JSON.stringify({ a: 1 }));
		const written = await rewriteJson<{ a: number }>(
			night.env.BUCKET as R2Bucket,
			"settings/x.json",
			(stored) => ({ a: (stored?.a ?? 0) + 1 }),
		);
		expect(written).toEqual({ a: 2 });
		expect(night.seen.get("settings/x.json")).toBe(2);
	});
});

describe("readRetrying", () => {
	const noWait = async () => {};
	it("gives up after five reads and throws what R2 said", async () => {
		let reads = 0;
		await expect(
			readRetrying(
				async () => {
					reads += 1;
					throw slowDown();
				},
				"raw",
				undefined,
				noWait,
			),
		).rejects.toThrow("(10058)");
		expect(reads).toBe(5);
	});

	// Inside the ten seconds the run's record is given, jitter and all.
	it("waits under six seconds in all", () => {
		const most = [250, 500, 1000, 2000].reduce((a, b) => a + b * 1.5, 0);
		expect(most).toBeLessThan(6000);
	});

	it("says which kind of object would not read, and not which one", async () => {
		const night = failing((key) =>
			key === "raw/m001.eml"
				? Object.assign(new Error("get: internal (10001)"), { code: 10001 })
				: null,
		);
		await expect(
			getBytes(night.env.BUCKET as R2Bucket, "raw/m001.eml"),
		).rejects.toThrow(/^raw\/…: get: internal \(10001\)$/);
	});

	it("does not read again on any other failure", async () => {
		let reads = 0;
		await expect(
			readRetrying(
				async () => {
					reads += 1;
					throw Object.assign(new Error("get: internal (10001)"), {
						code: 10001,
					});
				},
				"raw",
				undefined,
				noWait,
			),
		).rejects.toThrow("(10001)");
		expect(reads).toBe(1);
	});
});
