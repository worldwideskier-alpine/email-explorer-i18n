import {
	createExecutionContext,
	createScheduledController,
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKeyPrefix } from "../../src/auto-backup";
import { stepMailboxBackup } from "../../src/backup-writer";
import { keepOwnNight } from "../../src/durableObject";
import type { NightStatus } from "../../src/mailbox-night";
import { nightFor } from "../../src/mailbox-night";
import type { MaintenanceRecord } from "../../src/maintenance-record";
import {
	MAINTENANCE_KEY,
	readMaintenanceHistory,
	readMaintenanceRecord,
	writeMaintenanceRecord,
} from "../../src/maintenance-record";
import { firingOf, runScheduledMaintenance } from "../../src/scheduled-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * On 2026-10-13 the runtime called the cron twice for one firing, 7.4 s
 * apart. Each began the night, each wrote the run's record over the other's,
 * the second moved the first's half-written record into the history -- where
 * /root read it as a run cut off in the backups -- and the alarm of the night
 * the first had begun put that night back over the second's, so the second
 * asked fourteen minutes for a night that was not there and counted both
 * mailboxes failed.
 */

const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const stub = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const fireAlarm = () =>
	runDurableObjectAlarm(stub() as unknown as DurableObjectStub);

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

async function backupsOn() {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: {
					autoBackup: { enabled: true, frequency: "daily", keep: 7 },
					spamRetention: { enabled: true, days: 30 },
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

async function settings() {
	const object = (await bucket().get(
		`mailboxes/${mailboxId}.json`,
	)) as R2ObjectBody;
	return object.json<{
		autoBackup?: { lastResult?: { ok: boolean; error?: string } };
	}>();
}

/** This `env`, counting the questions its calls put to the mailboxes' nights. */
function counting() {
	let asked = 0;
	const real = env.MAILBOX;
	const MAILBOX = {
		idFromName: (name: string) => real.idFromName(name),
		get: (id: DurableObjectId) => {
			const target = real.get(id) as unknown as Record<string, unknown>;
			return new Proxy(target, {
				get(t, prop) {
					if (prop === "startNight" || prop === "nightStatus") {
						return (...args: unknown[]) => {
							asked += 1;
							return (t[prop] as (...a: unknown[]) => unknown)(...args);
						};
					}
					return Reflect.get(t, prop);
				},
			});
		},
	};
	return {
		env: { ...(env as unknown as Record<string, unknown>), MAILBOX },
		asked: () => asked,
	};
}

type Scheduled = (
	controller: ScheduledController,
	env: unknown,
	ctx: ExecutionContext,
) => Promise<void>;

async function scheduledHandler() {
	return ((await import("../../dev/index")).default as { scheduled: Scheduled })
		.scheduled;
}

function fireThrough(scheduled: Scheduled, at: number) {
	const ctx = createExecutionContext();
	return scheduled(
		createScheduledController({
			scheduledTime: new Date(at),
			cron: "0 18 * * *",
		}),
		env,
		ctx,
	).then(() => waitOnExecutionContext(ctx));
}

describe("the cron called twice for one firing", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
	});

	const yesterday = () => ({
		startedAt: new Date(Date.now() - 86_400_000).toISOString(),
		finishedAt: new Date(Date.now() - 86_000_000).toISOString(),
	});

	it("runs the night once: the second call stands aside at once", async () => {
		// Large enough that the first is still writing when the second comes.
		await seed(40, 400 * 1024);
		const before = yesterday();
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(before));
		const minute = Math.floor(Date.now() / 60_000) * 60_000;
		const one = counting();
		const two = counting();

		const first = runScheduledMaintenance(
			one.env as never,
			firingOf(minute),
			{ pollMs: 20 },
			minute,
		);
		// The second comes once the first has begun the nights, as it did.
		for (let i = 0; i < 500; i++) {
			if ((await readMaintenanceRecord(env as never))?.backupProgress) break;
			await sleep(10);
		}
		const second = await runScheduledMaintenance(
			two.env as never,
			firingOf(minute + 7449),
			{ pollMs: 20 },
			minute + 7449,
		);
		// Asked nothing of any night: it did not begin them again, nor wait.
		expect(two.asked()).toBe(0);
		expect(second.stoodAside).toBe(true);
		// And the first was still under way: what follows held while both
		// were writing, not after one had finished.
		expect((await readMaintenanceRecord(env as never))?.finishedAt).toBe(
			undefined,
		);
		const summary = await first;
		expect(summary.backups).toMatchObject({ ran: 1, failed: 0 });

		expect(await readMaintenanceHistory(env as never)).toEqual([before]);
		const record = await readMaintenanceRecord(env as never);
		expect(record?.startedAt).toBe(new Date(minute).toISOString());
		expect(record?.backups).toMatchObject({ ran: 1, failed: 0 });
		expect(record?.spamPurge).toMatchObject({ ran: 1, failed: 0 });
		expect(record?.finishedAt).toBeTypeOf("string");
		expect(record?.calls?.map((call) => !!call.stoodAside)).toEqual([
			false,
			true,
		]);
		expect(record?.calls?.[1]?.scheduledTime).toBe(
			new Date(minute + 7449).toISOString(),
		);
		expect(await archives()).toHaveLength(1);
		expect((await settings()).autoBackup?.lastResult?.ok).toBe(true);
	}, 60_000);

	it("knows the firing by its scheduled minute, through the handler", async () => {
		await seed(15);
		const before = yesterday();
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(before));
		const scheduled = await scheduledHandler();
		const minute = Math.floor(Date.now() / 60_000) * 60_000;

		await fireThrough(scheduled, minute);
		await fireThrough(scheduled, minute + 7449);

		expect(await readMaintenanceHistory(env as never)).toEqual([before]);
		const record = await readMaintenanceRecord(env as never);
		expect(record?.startedAt).toBe(new Date(minute).toISOString());
		expect(record?.calls).toHaveLength(2);
		expect(record?.calls?.[1]?.stoodAside).toBe(true);
		expect(record?.backups).toMatchObject({ ran: 1, failed: 0 });
		expect(await archives()).toHaveLength(1);
	}, 60_000);

	it("is taken over by a later call when it threw before beginning anything", async () => {
		await seed(15);
		const minute = Math.floor(Date.now() / 60_000) * 60_000;
		const settingsKey = `mailboxes/${mailboxId}.json`;
		const broken = new Proxy(bucket(), {
			get(target, prop) {
				const value = Reflect.get(target, prop);
				if (prop === "get") {
					return async (key: string, ...rest: unknown[]) => {
						if (key === settingsKey) {
							// Not one R2 says to try again: that is tried again
							// for seconds first (r2-retry.ts).
							throw new Error("get: Network connection lost.");
						}
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
		await expect(
			runScheduledMaintenance(
				{ ...(env as unknown as object), BUCKET: broken } as never,
				firingOf(minute),
				{ pollMs: 20 },
				minute,
			),
		).rejects.toThrow("Network connection lost.");
		const threw = await readMaintenanceRecord(env as never);
		expect(threw?.backups?.error).toContain("Network connection lost.");
		expect(threw?.finishedAt).toBeTypeOf("string");

		// The runtime trying the firing again, most likely.
		const again = await runScheduledMaintenance(
			env as never,
			firingOf(minute + 30_000),
			{ pollMs: 20 },
			minute + 30_000,
		);
		expect(again.stoodAside).toBeUndefined();
		const record = await readMaintenanceRecord(env as never);
		expect(record?.backups).toMatchObject({ ran: 1, failed: 0 });
		expect(record?.backups?.error).toBeUndefined();
		expect(record?.calls).toHaveLength(2);
		expect(await archives()).toHaveLength(1);
	}, 60_000);
});

describe("a call that cannot tell whether it owns the night", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
		await seed(15);
	});

	// The record is a diagnostic: a night not run for want of it is worse.
	it("runs the night all the same", async () => {
		const blind = new Proxy(bucket(), {
			get(target, prop) {
				const value = Reflect.get(target, prop);
				if (prop === "get") {
					return async (key: string, ...rest: unknown[]) => {
						if (key === MAINTENANCE_KEY) {
							throw new Error("get: Network connection lost.");
						}
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
		const summary = await runScheduledMaintenance(
			{ ...(env as unknown as object), BUCKET: blind } as never,
			new Date(),
			{ pollMs: 20 },
		);
		expect(summary.stoodAside).toBeUndefined();
		expect(summary.backups).toMatchObject({ ran: 1, failed: 0 });
		expect(await archives()).toHaveLength(1);
	}, 60_000);
});

describe("a mailbox's night asked for again", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
		await seed(15, 800 * 1024);
	});

	/** A night whose backup has paused one slice in, its upload open. */
	async function pausedNight(night: Date) {
		const first = await stepMailboxBackup(
			env as never,
			mailboxId,
			night,
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
			...nightFor(mailbox as never, night),
			state: "continuing",
			backup: { state: "running", slices: 1, messages: 12 },
		};
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", { mailbox, status: between });
			await state.storage.setAlarm(Date.now() + 60 * 60_000);
		});
		return mailbox;
	}

	it("is left to carry on when it is the same night, upload and all", async () => {
		const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const mailbox = await pausedNight(NOW);

		await stub().startNight(mailbox as never, NOW.toISOString());

		expect(await carried()).toHaveLength(2);
		const status = (await stub().nightStatus(
			NOW.toISOString(),
		)) as NightStatus | null;
		expect(status?.state).toBe("continuing");
		expect(await fireAlarm()).toBe(true);
		const ended = (await stub().nightStatus(
			NOW.toISOString(),
		)) as NightStatus | null;
		expect(ended?.backup).toMatchObject({ state: "ran", slices: 2 });
		expect(await archives()).toHaveLength(1);
		expect(await carried()).toEqual([]);
	}, 60_000);

	it("is not given up for a call for another minute the same evening", async () => {
		const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const mailbox = await pausedNight(NOW);
		const later = new Date(NOW.getTime() + 60_000).toISOString();

		await stub().startNight(mailbox as never, later);

		expect(await carried()).toHaveLength(2);
		expect(await stub().nightStatus(later)).toBeNull();
		expect(await fireAlarm()).toBe(true);
		const ended = (await stub().nightStatus(
			NOW.toISOString(),
		)) as NightStatus | null;
		expect(ended?.backup).toMatchObject({ state: "ran", slices: 2 });
		expect(await archives()).toHaveLength(1);
	}, 60_000);

	it("is not run again when it has ended", async () => {
		const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const mailbox = { id: mailboxId, settings: await settings() };
		const ended: NightStatus = {
			...nightFor(mailbox as never, NOW),
			state: "done",
			backup: { state: "ran" },
			purge: { state: "ran", deleted: 0 },
		};
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", { mailbox, status: ended });
		});

		await stub().startNight(mailbox as never, NOW.toISOString());

		expect(await stub().nightStatus(NOW.toISOString())).toEqual(ended);
		const alarm = await runInDurableObject(stub(), (_i, state) =>
			state.storage.getAlarm(),
		);
		expect(alarm).toBeNull();
	});

	it("is set going again when it never began and has no alarm", async () => {
		const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const mailbox = { id: mailboxId, settings: await settings() };
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", {
				mailbox,
				status: nightFor(mailbox as never, NOW),
			});
			await state.storage.deleteAlarm();
		});

		await stub().startNight(mailbox as never, NOW.toISOString());

		// The alarm runs it, here as in production; without one it would sit
		// "scheduled" while the cron asked for fourteen minutes.
		let state: string | undefined;
		for (let i = 0; i < 500 && state !== "done"; i++) {
			const status = (await stub().nightStatus(
				NOW.toISOString(),
			)) as NightStatus | null;
			state = status?.state;
			if (state !== "done") await sleep(10);
		}
		expect(state).toBe("done");
	}, 30_000);

	// The guard is for the same evening only: the next night still gives up
	// a backup that was never going to finish.
	it("is given up for the next night, as before", async () => {
		const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const mailbox = await pausedNight(NOW);
		const tomorrow = new Date(NOW.getTime() + 86_400_000).toISOString();

		await stub().startNight(mailbox as never, tomorrow);

		expect(await carried()).toEqual([]);
		const status = (await stub().nightStatus(tomorrow)) as NightStatus | null;
		expect(status?.state).toBe("scheduled");
	}, 60_000);
});

/**
 * The end-to-end race is not reproduced here: in this pool a question to the
 * object seldom reached it while its alarm was writing the backup (a status of
 * "running" was read on 1 of 6 tries; the rest read "ran"), where in
 * production the cron's questions do. So the rule is held where it is decided.
 */
describe("a night's alarm", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
	});

	it("does not put its night back over a newer one", async () => {
		const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const newer = new Date(NOW.getTime() + 60_000);
		const mailbox = { id: mailboxId, settings: await settings() };
		const kept = await runInDurableObject(stub(), async (_i, state) => {
			// What a second call's startNight put down, on 2026-10-13.
			await state.storage.put("night", {
				mailbox,
				status: nightFor(mailbox as never, newer),
			});
			await keepOwnNight(state.storage, {
				mailbox: mailbox as never,
				status: {
					...nightFor(mailbox as never, NOW),
					state: "running",
					backup: { state: "running", messages: 300 },
				},
			});
			return state.storage.get<{ status: NightStatus }>("night");
		});
		expect(kept?.status.night).toBe(newer.toISOString());
		expect(kept?.status.state).toBe("scheduled");
	});

	it("puts down its own night as it goes", async () => {
		const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
		const mailbox = { id: mailboxId, settings: await settings() };
		const kept = await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", {
				mailbox,
				status: nightFor(mailbox as never, NOW),
			});
			await keepOwnNight(state.storage, {
				mailbox: mailbox as never,
				status: {
					...nightFor(mailbox as never, NOW),
					state: "running",
					backup: { state: "running", messages: 300 },
				},
			});
			return state.storage.get<{ status: NightStatus }>("night");
		});
		expect(kept?.status.backup.messages).toBe(300);
	});
});

describe("the run's record", () => {
	beforeEach(async () => {
		await bucket().delete(MAINTENANCE_KEY);
	});

	const tonight: MaintenanceRecord = {
		startedAt: "2026-10-13T18:00:00.000Z",
		owner: "first",
		calls: [
			{
				scheduledTime: "2026-10-13T18:00:00.000Z",
				at: "2026-10-13T18:00:12.604Z",
			},
			{
				scheduledTime: "2026-10-13T18:00:00.000Z",
				at: "2026-10-13T18:00:20.053Z",
				stoodAside: true,
			},
		],
		backupProgress: { mailbox: "x", index: 1, of: 2, messages: 300 },
	};

	it("is written by the call that owns the night and no other", async () => {
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(tonight));
		await writeMaintenanceRecord(env as never, {
			startedAt: tonight.startedAt,
			owner: "second",
			backups: {
				finishedAt: "2026-10-13T18:14:20.179Z",
				considered: 2,
				ran: 0,
				failed: 2,
			},
		});
		expect(await readMaintenanceRecord(env as never)).toEqual(tonight);
	});

	it("keeps the calls that stood aside when its owner writes", async () => {
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(tonight));
		await writeMaintenanceRecord(env as never, {
			startedAt: tonight.startedAt,
			owner: "first",
			calls: [tonight.calls?.[0] as never],
			backupProgress: { mailbox: "x", index: 1, of: 2, messages: 900 },
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.calls).toEqual(tonight.calls);
		expect(record?.backupProgress?.messages).toBe(900);
	});

	it("is never put over a later night's", async () => {
		const later = { ...tonight, startedAt: "2026-10-14T18:00:00.000Z" };
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(later));
		await writeMaintenanceRecord(env as never, {
			startedAt: tonight.startedAt,
			owner: "first",
		});
		expect(await readMaintenanceRecord(env as never)).toEqual(later);
	});
});
