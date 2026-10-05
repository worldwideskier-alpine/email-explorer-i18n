import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKeyPrefix } from "../../src/auto-backup";
import { stepMailboxBackup, writeMailboxBackup } from "../../src/backup-writer";
import type { NightStatus } from "../../src/mailbox-night";
import { inlineNights, nightFor } from "../../src/mailbox-night";
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
 * A backup written a slice at a time, each slice in its own alarm.
 *
 * An alarm has thirty seconds of CPU and fifteen minutes of wall time, and a
 * mailbox does not stop growing: on 2026-10-01 the larger one came to 401 MB.
 * Written in one go, some night it would not fit, and nobody should have to
 * watch for that night. So the archive is written in slices that pause and
 * carry on in the next alarm -- and the archive that comes out has to be the
 * very one a single pass would have written, or a restore finds the seam.
 */

// Tonight, not a date: a night carried on more than twenty hours after it
// began is given up (NIGHT_LONGEST_MS), against the real clock. Fixed at
// 2026-10-02, these tests began failing twenty hours later.
const NOW = new Date();
const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const stub = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
const fireAlarm = () =>
	runDurableObjectAlarm(stub() as unknown as DurableObjectStub);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Messages big enough that the archive needs several parts. */
async function seed(count: number, bytesEach = 800 * 1024) {
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
			`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: s${i}\r\n\r\nFrom the start\r\n${body}\r\n`,
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

async function backupsOn() {
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
}

async function archives() {
	const listed = await bucket().list({ prefix: backupKeyPrefix(mailboxId) });
	return listed.objects.map((o) => o.key);
}

async function carried() {
	const listed = await bucket().list({ prefix: "backup-carry/" });
	return listed.objects.map((o) => o.key);
}

async function digest(key: string) {
	const object = (await bucket().get(key)) as R2ObjectBody;
	const bytes = await object.arrayBuffer();
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return {
		size: bytes.byteLength,
		sha: [...new Uint8Array(hash)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(""),
	};
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

describe("a backup written in slices", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
		// Fifteen of about 800 KB: three parts, and a pause after the first
		// twelve leaves a part and a half written -- the half has to be carried.
		await seed(15);
	});

	it("comes out the same archive as one written in one go", async () => {
		const whole = await writeMailboxBackup(env as never, mailboxId, NOW, 7);
		const once = await digest(whole.key);
		expect(once.size).toBeGreaterThan(10 * 1024 * 1024);
		await bucket().delete(whole.key);

		let slices = 0;
		let step: Awaited<ReturnType<typeof stepMailboxBackup>>;
		do {
			step = await stepMailboxBackup(
				env as never,
				mailboxId,
				NOW,
				7,
				undefined,
				undefined,
				{},
				undefined,
				{ bytes: 1, until: Date.now() + 60_000, resume: slices > 0 },
			);
			slices += 1;
			if (step.kind === "paused") expect(await carried()).toHaveLength(2);
		} while (step.kind === "paused");

		expect(slices).toBeGreaterThan(1);
		expect(step.result.messages).toBe(15);
		expect(await digest(step.result.key)).toEqual(once);
		// Nothing of the pause is left behind.
		expect(await carried()).toEqual([]);
	}, 60_000);

	it("carries on in the next alarm until the archive is whole", async () => {
		// The first slice, then the night as the alarm finds it between two.
		const first = await stepMailboxBackup(
			env as never,
			mailboxId,
			NOW,
			7,
			undefined,
			undefined,
			{},
			undefined,
			{ bytes: 1, until: Date.now() + 60_000 },
		);
		expect(first.kind).toBe("paused");
		const mailbox = { id: mailboxId, settings: await settings() };
		const between: NightStatus = {
			...nightFor(mailbox as never, NOW),
			state: "continuing",
			backup: { state: "running", slices: 1, messages: 12 },
		};
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", { mailbox, status: between });
			await state.storage.setAlarm(Date.now() + 60 * 60_000);
		});

		expect(await fireAlarm()).toBe(true);

		const status = (await stub().nightStatus(
			NOW.toISOString(),
		)) as NightStatus | null;
		expect(status?.state).toBe("done");
		expect(status?.backup).toMatchObject({ state: "ran", slices: 2 });
		expect(await archives()).toHaveLength(1);
		expect(await carried()).toEqual([]);
		expect((await settings()).autoBackup?.lastResult).toMatchObject({
			ok: true,
			messages: 15,
		});
	}, 60_000);

	it("is given up, upload and all, when the runtime ended a slice", async () => {
		await stepMailboxBackup(
			env as never,
			mailboxId,
			NOW,
			7,
			undefined,
			undefined,
			{},
			undefined,
			{ bytes: 1, until: Date.now() + 60_000 },
		);
		expect(await carried()).toHaveLength(2);
		const mailbox = { id: mailboxId, settings: await settings() };
		const killed: NightStatus = {
			...nightFor(mailbox as never, NOW),
			state: "running",
			backup: { state: "running", slices: 2 },
		};
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", { mailbox, status: killed });
			await state.storage.setAlarm(Date.now() + 60 * 60_000);
		});

		expect(await fireAlarm()).toBe(true);

		expect(await carried()).toEqual([]);
		expect(await archives()).toEqual([]);
		expect((await settings()).autoBackup?.lastResult?.error).toContain(
			"ended by the runtime",
		);
	}, 60_000);

	it("is given up when it would not end before the next night", async () => {
		const summary = await runScheduledMaintenance(env as never, NOW, {
			nights: inlineNights,
			sliceBytes: 1,
			maxSlices: 1,
			pollMs: 20,
		});
		expect(summary.backups).toMatchObject({ ran: 0, failed: 1 });
		expect(await carried()).toEqual([]);
		expect(await archives()).toEqual([]);
		expect((await settings()).autoBackup?.lastResult?.error).toContain(
			"given up",
		);
	}, 60_000);
});

/**
 * The cron waits fourteen minutes and a night may carry on past that. It is
 * then neither ran nor failed in the run's record but listed as continuing,
 * and the night counts itself in when it ends -- so a big mailbox is not
 * reported as a failed backup it was not.
 */
describe("a night the cron stopped waiting for", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
		await seed(15);
	});

	it("is counted in the run's record when it ends", async () => {
		// Each pause held up long enough to outlast the cron's wait.
		const slow = {
			...(env as unknown as Record<string, unknown>),
			BUCKET: new Proxy(bucket(), {
				get(target, prop) {
					const value = Reflect.get(target, prop);
					if (prop === "put") {
						return async (key: string, ...rest: unknown[]) => {
							if (key.startsWith("backup-carry/")) await sleep(400);
							return (value as (...a: unknown[]) => unknown).call(
								target,
								key,
								...rest,
							);
						};
					}
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};

		const summary = await runScheduledMaintenance(slow as never, NOW, {
			nights: inlineNights,
			sliceBytes: 1,
			waitByMs: 300,
			pollMs: 20,
		});
		expect(summary.backups).toMatchObject({ ran: 0, failed: 0 });
		const waited = await readMaintenanceRecord(env as never);
		expect(waited?.continuing).toEqual([{ mailbox: mailboxId, backup: true }]);
		expect(waited?.finishedAt).toBeTypeOf("string");

		let record = waited;
		for (let i = 0; i < 100 && record?.continuing?.length; i++) {
			await sleep(100);
			record = await readMaintenanceRecord(env as never);
		}
		expect(record?.continuing).toEqual([]);
		expect(record?.backups).toMatchObject({ ran: 1, failed: 0 });
		// What the cron wrote after it stopped waiting is still there.
		expect(record?.finishedAt).toBe(waited?.finishedAt);
		expect(await archives()).toHaveLength(1);
		expect(await bucket().head(MAINTENANCE_KEY)).not.toBeNull();
	}, 60_000);
});

describe("a mailbox deleted while its backup is paused", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
		await seed(15);
	});

	it("takes the paused backup with it", async () => {
		await stepMailboxBackup(
			env as never,
			mailboxId,
			NOW,
			7,
			undefined,
			undefined,
			{},
			undefined,
			{ bytes: 1, until: Date.now() + 60_000 },
		);
		expect(await carried()).toHaveLength(2);
		const { destroyMailboxCompletely } = await import(
			"../../src/mailbox-destroy"
		);
		await destroyMailboxCompletely(env as never, mailboxId);
		expect(await carried()).toEqual([]);
		expect(await archives()).toEqual([]);
	}, 60_000);
});
