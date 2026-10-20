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

type UploadCall = "create" | "part" | "complete";

const internalError = (call: string) =>
	Object.assign(
		new Error(
			`${call}: We encountered an internal error. Please try again. (10001)`,
		),
		{ code: 10001 },
	);

/** An archive upload whose calls `fail(call, n)` decides; see `failing`. */
function failingUpload(
	upload: R2MultipartUpload,
	fail: (call: UploadCall, n: number) => Error | "after" | null,
	seen: Map<string, number>,
): R2MultipartUpload {
	const attempt = async <T>(
		call: UploadCall,
		real: () => Promise<T>,
	): Promise<T> => {
		const n = (seen.get(call) ?? 0) + 1;
		seen.set(call, n);
		const error = fail(call, n);
		if (error === "after") {
			// Done, and the answer lost on the way back.
			await real();
			throw internalError(call);
		}
		if (error) throw error;
		return real();
	};
	return new Proxy(upload, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (prop === "uploadPart") {
				return (number: number, bytes: Uint8Array) =>
					attempt("part", () => target.uploadPart(number, bytes));
			}
			if (prop === "complete") {
				return (parts: R2UploadedPart[]) =>
					attempt("complete", () => target.complete(parts));
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * The bucket, with `fail(key, n)` deciding which gets throw what -- and, for
 * `"body"`, which come back with a body that will not read -- and
 * `failUpload(call, n)` which of an archive upload's calls do: `"after"` is
 * a call that was done and whose answer was lost.
 */
function failing(
	fail: (key: string, n: number) => Error | "body" | null,
	failUpload: (call: UploadCall, n: number) => Error | "after" | null = () =>
		null,
) {
	const seen = new Map<string, number>();
	const proxied = new Proxy(bucket(), {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (prop === "createMultipartUpload") {
				return async (key: string, ...rest: unknown[]) => {
					const n = (seen.get("create") ?? 0) + 1;
					seen.set("create", n);
					const error = failUpload("create", n);
					if (error === "after") {
						await target.createMultipartUpload(key, ...(rest as []));
						throw internalError("createMultipartUpload");
					}
					if (error) throw error;
					return failingUpload(
						await target.createMultipartUpload(key, ...(rest as [])),
						failUpload,
						seen,
					);
				};
			}
			if (prop === "resumeMultipartUpload") {
				return (key: string, uploadId: string) =>
					failingUpload(
						target.resumeMultipartUpload(key, uploadId),
						failUpload,
						seen,
					);
			}
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
		// Read five times: R2 said to try again, and refused every time.
		expect(night.seen.get("raw/m005.eml")).toBe(5);
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
				? Object.assign(new Error("get: invalid object name (10020)"), {
						code: 10020,
					})
				: null,
		);
		await expect(
			getBytes(night.env.BUCKET as R2Bucket, "raw/m001.eml"),
		).rejects.toThrow(/^raw\/…: get: invalid object name \(10020\)$/);
	});

	it("reads again when R2 says it erred and to try again", async () => {
		let reads = 0;
		await expect(
			readRetrying(
				async () => {
					reads += 1;
					if (reads === 1) throw internalError("get");
					return "read";
				},
				"raw",
				undefined,
				noWait,
			),
		).resolves.toBe("read");
		expect(reads).toBe(2);
	});

	it("does not read again on any other failure", async () => {
		for (const error of [
			Object.assign(new Error("get: invalid object name (10020)"), {
				code: 10020,
			}),
			new Error("Network connection lost."),
			"not an Error",
		]) {
			let reads = 0;
			await expect(
				readRetrying(
					async () => {
						reads += 1;
						throw error;
					},
					"raw",
					undefined,
					noWait,
				),
			).rejects.toBe(error);
			expect(reads).toBe(1);
		}
	});
});

describe("R2 saying to try a call of the archive's upload again", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		// Three parts: two whole ones and the last.
		await seed(30, 400 * 1024);
	});

	const backUp = (bucketEnv: unknown, at: string) =>
		stepMailboxBackup(bucketEnv as never, mailboxId, new Date(at), 7);

	/**
	 * The archive by its length and digest: compared byte by byte, two
	 * archives of this size ran the test pool out of memory.
	 */
	async function bytesOf(key: string) {
		const object = (await bucket().get(key)) as R2ObjectBody;
		const bytes = await object.arrayBuffer();
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return {
			byteLength: bytes.byteLength,
			sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
				"",
			),
		};
	}

	/** The archive a backup that met no refusal writes, to compare with. */
	async function untroubled() {
		const step = await backUp(env, "2026-10-01T18:00:00.000Z");
		if (step.kind !== "done") throw new Error("the backup paused");
		return bytesOf(step.result.key);
	}

	async function written(
		failUpload: (call: UploadCall, n: number) => Error | "after" | null,
	) {
		const night = failing(() => null, failUpload);
		const step = await backUp(night.env, "2026-10-17T18:00:00.000Z");
		if (step.kind !== "done") throw new Error("the backup paused");
		return { night, bytes: await bytesOf(step.result.key) };
	}

	// What the night of 2026-10-17 met, and lost its archive to.
	it("costs a refused part a second upload, not the archive", async () => {
		const { night, bytes } = await written((call, n) =>
			call === "part" && n === 1 ? internalError("uploadPart") : null,
		);
		expect(night.seen.get("part")).toBe(4);
		expect(bytes).toEqual(await untroubled());
	}, 30_000);

	// The bytes are taken from the buffer once: taken again, the part sent
	// second would hold the next part's bytes and the archive would be short.
	it("sends a part again whole when its answer was lost", async () => {
		const { night, bytes } = await written((call, n) =>
			call === "part" && n === 2 ? "after" : null,
		);
		expect(night.seen.get("part")).toBe(4);
		expect(bytes.byteLength).toBeGreaterThan(10 * 1024 * 1024);
		expect(bytes).toEqual(await untroubled());
	}, 30_000);

	it("starts and completes the upload again when R2 says to", async () => {
		const { night, bytes } = await written((call, n) =>
			(call === "create" || call === "complete") && n === 1
				? internalError(call)
				: null,
		);
		expect(night.seen.get("create")).toBe(2);
		expect(night.seen.get("complete")).toBe(2);
		expect(bytes).toEqual(await untroubled());
	}, 30_000);

	// Measured in the test pool, not on R2: a second completion answers that
	// there is no such upload, and the abort after it leaves the archive. The
	// night is counted failed with its archive written, as it was before the
	// second try existed.
	it("keeps the archive when a completion's answer was lost", async () => {
		const night = failing(
			() => null,
			(call, n) => (call === "complete" && n === 1 ? "after" : null),
		);
		await expect(backUp(night.env, "2026-10-17T18:00:00.000Z")).rejects.toThrow(
			"(10024)",
		);
		expect(night.seen.get("complete")).toBe(2);
		const [key] = await archives();
		expect(key).toBeDefined();
		expect(await bytesOf(key as string)).toEqual(await untroubled());
	}, 30_000);

	it("does not upload again on any other failure", async () => {
		const night = failing(
			() => null,
			(call) =>
				call === "part"
					? new Error("uploadPart: Network connection lost.")
					: null,
		);
		await expect(backUp(night.env, "2026-10-17T18:00:00.000Z")).rejects.toThrow(
			"Network connection lost.",
		);
		expect(night.seen.get("part")).toBe(1);
		expect(await archives()).toEqual([]);
	}, 30_000);

	it("gives up after five tries and says what R2 said", async () => {
		const night = failing(
			() => null,
			(call) => (call === "part" ? internalError("uploadPart") : null),
		);
		await expect(backUp(night.env, "2026-10-17T18:00:00.000Z")).rejects.toThrow(
			"uploading part of the archive: uploadPart: We encountered an internal error. Please try again. (10001)",
		);
		expect(night.seen.get("part")).toBe(5);
		expect(await archives()).toEqual([]);
	}, 30_000);
});
