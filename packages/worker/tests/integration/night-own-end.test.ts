import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { judgeNight } from "../../scripts/night-check.mjs";
import { backupKeyPrefix } from "../../src/auto-backup";
import { OutOfTime } from "../../src/deadline";
import {
	type NightStatus,
	nightFor,
	runMailboxNight,
} from "../../src/mailbox-night";
import {
	claimNight,
	MAINTENANCE_HISTORY_KEY,
	MAINTENANCE_KEY,
	type MaintenanceRecord,
	maintenanceForRoot,
	nightsEndedOf,
	readMaintenanceRecord,
	recordNightEnd,
	writeMaintenanceRecord,
} from "../../src/maintenance-record";
import { runScheduledMaintenance } from "../../src/scheduled-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	personId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Each mailbox's night writes how it ended into the run's record itself,
 * whatever becomes of the call that began it.
 *
 * On 2026-10-25 the call that owned the night began both mailboxes' nights,
 * wrote where the backups had got to at 18:02:36, and was heard from no more;
 * the runtime's second call five minutes later stood aside, as it should.
 * Both archives were written (18:01:49 and 18:02:48), and the record said
 * only that the run was cut off inside the backups: a night counted itself
 * into the record only when the call had listed it as still going, and a
 * call that ended early listed nothing. The night check failed on a night
 * that had lost nothing, and nothing said so but R2 read by hand.
 *
 * Nobody stands in for the call: it writes its own part -- which nights it
 * began, and its end -- and each night its own.
 */

const NIGHT = new Date("2026-10-25T18:00:00.000Z");
const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const stub = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
const fireAlarm = () =>
	runDurableObjectAlarm(stub() as unknown as DurableObjectStub);

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

async function settings() {
	const object = (await bucket().get(
		`mailboxes/${mailboxId}.json`,
	)) as R2ObjectBody;
	return object.json<Record<string, unknown>>();
}

async function archives() {
	const listed = await bucket().list({ prefix: backupKeyPrefix(mailboxId) });
	return listed.objects.map((o) => o.key);
}

/**
 * The bucket as the call that owns the night sees it, until that call has
 * written which nights it began; after that nothing it writes lands, as
 * nothing did on 2026-10-25. The nights, in their own objects' alarms, write
 * through the deployment's own bucket.
 */
function endedAfterAppointing(): { bucket: R2Bucket; ended: () => boolean } {
	let ended = false;
	const real = bucket();
	const proxy = new Proxy(real, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]) => {
				if (ended) throw new Error("the invocation has ended");
				const result = await (value as (...a: unknown[]) => unknown).apply(
					target,
					args,
				);
				if (
					prop === "put" &&
					args[0] === MAINTENANCE_KEY &&
					result &&
					String(args[1]).includes('"appointed"')
				) {
					ended = true;
				}
				return result;
			};
		},
	});
	return { bucket: proxy, ended: () => ended };
}

describe("a mailbox's night writes how it ended into the run's record", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
	});

	it("when the call that began it ends before its own end, as on 2026-10-25", async () => {
		const owner = endedAfterAppointing();
		const firing = new Date();
		await runScheduledMaintenance(
			{ ...(env as unknown as object), BUCKET: owner.bucket } as never,
			firing,
			{ pollMs: 20 },
		);
		expect(owner.ended()).toBe(true);
		// The runtime's second call for the firing, five minutes on: it
		// stands aside, and what it writes keeps what the nights wrote.
		const second = await runScheduledMaintenance(env as never, firing, {
			pollMs: 20,
		});
		expect(second.stoodAside).toBe(true);
		expect(await archives()).toHaveLength(1);

		const record = (await readMaintenanceRecord(
			env as never,
		)) as MaintenanceRecord;
		// The call's own end never landed ...
		expect(record.finishedAt).toBeUndefined();
		expect(record.backups).toBeUndefined();
		// ... and the night said how it ended all the same.
		expect(record.appointed).toEqual([mailboxId]);
		expect(record.nights?.[mailboxId]).toMatchObject({
			backup: { state: "ran" },
			purge: { state: "skipped" },
		});

		// So the night check reads a night that lost nothing as one, and
		// says the call ended early without failing for it.
		const later = new Date(Date.parse(record.startedAt) + 30 * 60_000);
		const verdict = judgeNight(record, [], later, 0);
		expect(verdict.trouble).toEqual([]);
		expect(verdict.pending).toBeUndefined();
		expect(verdict.notes).toHaveLength(1);
		// What the call left undone is still trouble when it mattered.
		expect(judgeNight(record, [], later, 1).trouble).toEqual([
			expect.stringContaining("1 mailbox deletion(s) still not finished"),
		]);
	}, 60_000);

	it("when its alarm was ended partway and the retry finishes the record", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		await claimNight(env as never, NIGHT.toISOString(), "owner", {
			scheduledTime: NIGHT.toISOString(),
			at: NIGHT.toISOString(),
		});
		const underWay: NightStatus = {
			...nightFor(mailbox as never, NIGHT),
			state: "running",
			backup: { state: "running", messages: 0 },
		};
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", { mailbox, status: underWay });
			await state.storage.setAlarm(Date.now() + 60 * 60_000);
		});

		expect(await fireAlarm()).toBe(true);

		const record = await readMaintenanceRecord(env as never);
		expect(record?.nights?.[mailboxId]?.backup).toMatchObject({
			state: "failed",
			error: expect.stringContaining("ended by the runtime"),
		});
	});

	it("before it is marked done, so an alarm ended between the two writes it again", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		await claimNight(env as never, NIGHT.toISOString(), "owner", {
			scheduledTime: NIGHT.toISOString(),
			at: NIGHT.toISOString(),
		});
		let whenDone: MaintenanceRecord | null | undefined;
		const status = await runMailboxNight(
			env as never,
			mailbox as never,
			NIGHT,
			{},
			async (said) => {
				// The first time it says so, which is the moment that counts.
				if (said.state === "done" && whenDone === undefined) {
					whenDone = await readMaintenanceRecord(env as never);
				}
			},
		);
		expect(status.unrecorded).toBeUndefined();
		// Already in the run's record by the time the night says it is done.
		expect(whenDone?.nights?.[mailboxId]?.backup.state).toBe("ran");
	});

	it("and when that write fails, says so, and its alarm writes it once more", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		await claimNight(env as never, NIGHT.toISOString(), "owner", {
			scheduledTime: NIGHT.toISOString(),
			at: NIGHT.toISOString(),
		});
		const real = bucket();
		const refusing = new Proxy(real, {
			get(target, prop) {
				const value = Reflect.get(target, prop);
				if (prop === "put") {
					return async (...args: unknown[]) => {
						if (args[0] === MAINTENANCE_KEY) throw new Error("refused");
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const ended = await runMailboxNight(
			{ ...(env as unknown as object), BUCKET: refusing } as never,
			mailbox as never,
			NIGHT,
			{},
			async () => {},
		);
		expect(ended.state).toBe("done");
		expect(ended.unrecorded).toBe(true);
		expect(
			(await readMaintenanceRecord(env as never))?.nights?.[mailboxId],
		).toBeUndefined();

		// As the alarm it set a minute on finds it.
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", { mailbox, status: ended });
			await state.storage.setAlarm(Date.now() + 60 * 60_000);
		});
		expect(await fireAlarm()).toBe(true);
		const record = await readMaintenanceRecord(env as never);
		expect(record?.nights?.[mailboxId]?.backup.state).toBe("ran");
		const kept = (await stub().nightStatus(
			NIGHT.toISOString(),
		)) as NightStatus | null;
		expect(kept?.unrecorded).toBeUndefined();
	});

	it("into its own night's record and no other", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		const ended: NightStatus = {
			...nightFor(mailbox as never, NIGHT),
			state: "done",
			backup: { state: "ran" },
		};

		// None for tonight: none is made.
		await recordNightEnd(env as never, ended);
		expect(await readMaintenanceRecord(env as never)).toBeNull();

		// A later night's: left as it is.
		const later = { startedAt: "2026-10-26T18:00:00.000Z", owner: "x" };
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(later));
		await recordNightEnd(env as never, ended);
		expect(await readMaintenanceRecord(env as never)).toEqual(later);
	});

	it("and the owning call's later writes keep it", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		const startedAt = NIGHT.toISOString();
		await claimNight(env as never, startedAt, "owner", {
			scheduledTime: startedAt,
			at: startedAt,
		});
		await recordNightEnd(env as never, {
			...nightFor(mailbox as never, NIGHT),
			state: "done",
			backup: { state: "ran" },
		});
		// The call's own copy knows nothing of the night's entry.
		await writeMaintenanceRecord(env as never, {
			startedAt,
			owner: "owner",
			appointed: [mailboxId],
			finishedAt: new Date().toISOString(),
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.finishedAt).toBeDefined();
		expect(record?.nights?.[mailboxId]?.backup.state).toBe("ran");
	});

	it("and goes on trying when R2 says to try again", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		const startedAt = NIGHT.toISOString();
		await claimNight(env as never, startedAt, "owner", {
			scheduledTime: startedAt,
			at: startedAt,
		});
		let refusals = 2;
		const real = bucket();
		const busy = new Proxy(real, {
			get(target, prop) {
				const value = Reflect.get(target, prop);
				if (prop === "put") {
					return async (...args: unknown[]) => {
						if (args[0] === MAINTENANCE_KEY && refusals-- > 0) {
							throw new Error(
								"put: We encountered an internal error. Please try again. (10001)",
							);
						}
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await recordNightEnd({ BUCKET: busy } as never, {
			...nightFor(mailbox as never, NIGHT),
			state: "done",
			backup: { state: "ran" },
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.nights?.[mailboxId]?.backup.state).toBe("ran");
	});

	it("but not for one whose start only ran out of time: it may be going", async () => {
		await runScheduledMaintenance(env as never, new Date(), {
			pollMs: 20,
			waitByMs: 200,
			nights: () => ({
				start: async () => {
					throw new OutOfTime("starting the mailbox's night", 10_000);
				},
				status: async () => null,
			}),
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.appointed).toEqual([mailboxId]);
		expect(record?.nights?.[mailboxId]).toBeUndefined();
	});

	it("except one the call could not begin, which the call writes itself", async () => {
		await runScheduledMaintenance(env as never, new Date(), {
			pollMs: 20,
			nights: () => ({
				start: async () => {
					throw new Error("no answer");
				},
				status: async () => null,
			}),
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.appointed).toEqual([mailboxId]);
		expect(record?.nights?.[mailboxId]?.backup).toMatchObject({
			state: "failed",
			error: expect.stringContaining("Could not be started"),
		});
	});
	it("and one that ended before the call listed it as going is counted then", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		const startedAt = NIGHT.toISOString();
		await claimNight(env as never, startedAt, "owner", {
			scheduledTime: startedAt,
			at: startedAt,
		});
		// It ends, and is not listed yet: it writes its entry, counts nothing.
		await recordNightEnd(env as never, {
			...nightFor(mailbox as never, NIGHT),
			state: "done",
			backup: { state: "ran" },
		});
		// The call, which last saw it going, lists it and counts the rest.
		await writeMaintenanceRecord(env as never, {
			startedAt,
			owner: "owner",
			appointed: [mailboxId],
			continuing: [{ mailbox: mailboxId, backup: true }],
			backups: { finishedAt: startedAt, considered: 1, ran: 0, failed: 0 },
			spamPurge: {
				finishedAt: startedAt,
				considered: 1,
				ran: 0,
				failed: 0,
				deleted: 0,
			},
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.continuing).toEqual([]);
		expect(record?.backups).toMatchObject({ ran: 1, failed: 0 });
	});

	it("and goes on trying while other writers keep winning", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		const startedAt = NIGHT.toISOString();
		await claimNight(env as never, startedAt, "owner", {
			scheduledTime: startedAt,
			at: startedAt,
		});
		// Seven conditional puts lost in a row: more than rewriteJson's five.
		let losing = 7;
		const real = bucket();
		const contested = new Proxy(real, {
			get(target, prop) {
				const value = Reflect.get(target, prop);
				if (prop === "put") {
					return async (...args: unknown[]) => {
						if (args[0] === MAINTENANCE_KEY && losing > 0) {
							losing--;
							return null;
						}
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await recordNightEnd({ BUCKET: contested } as never, {
			...nightFor(mailbox as never, NIGHT),
			state: "done",
			backup: { state: "ran" },
		});
		const record = await readMaintenanceRecord(env as never);
		expect(record?.nights?.[mailboxId]?.backup.state).toBe("ran");
	});
});

/**
 * Root's screen reads the run's record through its own routes, which give
 * counts and times. The nights' entries are kept by mailbox, and which
 * mailboxes there are is not root's business: the routes add them up.
 */
describe("the nights' entries as root's routes give them", () => {
	const entry = (backup: string, purge: string, deleted?: number) => ({
		endedAt: "2026-10-25T18:02:00.000Z",
		backup: { state: backup, ...(backup === "failed" ? { error: "R2" } : {}) },
		purge: { state: purge, ...(deleted !== undefined ? { deleted } : {}) },
	});
	const record = (): MaintenanceRecord =>
		({
			startedAt: NIGHT.toISOString(),
			appointed: ["a@example.com", "b@example.com", "c@example.com"],
			nights: {
				"a@example.com": entry("ran", "skipped"),
				"b@example.com": entry("failed", "ran", 4),
				"c@example.com": entry("skipped", "ran", 1),
			},
		}) as never;

	it("are added up once every night has ended, and not before", () => {
		expect(nightsEndedOf(record())).toEqual({
			backups: { considered: 3, ran: 1, failed: 1, reasons: ["R2"] },
			spamPurge: { considered: 3, ran: 2, failed: 0, deleted: 5 },
		});
		const open = record();
		delete open.nights?.["c@example.com"];
		expect(nightsEndedOf(open)).toBeUndefined();
		expect(
			nightsEndedOf({ ...record(), finishedAt: NIGHT.toISOString() }),
		).toBeUndefined();
		const { appointed: _, ...unlisted } = record();
		expect(nightsEndedOf(unlisted)).toBeUndefined();
	});

	it("are added up only once the call would have written its end", () => {
		const began = Date.parse(NIGHT.toISOString());
		expect(
			maintenanceForRoot(record(), began + 10 * 60_000).nightsEnded,
		).toBeUndefined();
		expect(
			maintenanceForRoot(record(), began + 16 * 60_000).nightsEnded,
		).toEqual(nightsEndedOf(record()));
	});

	it("count the sixteen minutes from the call that took the night over", () => {
		const began = Date.parse(NIGHT.toISOString());
		const takenOver = {
			...record(),
			calls: [
				{ scheduledTime: NIGHT.toISOString(), at: NIGHT.toISOString() },
				{
					scheduledTime: NIGHT.toISOString(),
					at: new Date(began + 5 * 60_000).toISOString(),
				},
			],
		};
		expect(
			maintenanceForRoot(takenOver, began + 17 * 60_000).nightsEnded,
		).toBeUndefined();
		expect(
			maintenanceForRoot(takenOver, began + 21 * 60_000).nightsEnded,
		).toBeDefined();
	});

	it("name no mailbox, last night's or the history's", async () => {
		await testAuthBeforeAll();
		await runInDurableObject(
			env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")),
			async (_instance, state) => {
				state.storage.sql.exec(
					"UPDATE app_roles SET root_person_id = ? WHERE id = 1",
					personId,
				);
			},
		);
		await bucket().put(MAINTENANCE_KEY, JSON.stringify(record()));
		await bucket().put(MAINTENANCE_HISTORY_KEY, JSON.stringify([record()]));

		for (const path of ["", "/history"]) {
			const res = await authenticatedFetch(
				`http://local.test/api/v1/root/maintenance${path}`,
			);
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).not.toContain("@example.com");
			const body = JSON.parse(text);
			expect((Array.isArray(body) ? body[0] : body).nightsEnded).toEqual(
				nightsEndedOf(record()),
			);
		}
	});
});
