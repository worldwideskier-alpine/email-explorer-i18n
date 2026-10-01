/**
 * Everything the daily cron does, in the order it has to do it.
 *
 * The order is the point of this file existing rather than the two calls
 * sitting inline in the handler: **the backup runs first and the spam purge
 * second**, so a message the purge deletes tonight is already inside tonight's
 * archive and stays recoverable for as long as that archive is kept. The
 * order is kept per mailbox, inside each mailbox's own night: see
 * mailbox-night.ts, which is also where the work now runs. This file starts
 * the nights, waits for them, and writes down how they went.
 *
 * Reversed, the purge would delete a message and the backup taken minutes
 * later would be the first one without it -- a permanent deletion with no copy
 * anywhere, which is not something to offer behind a checkbox. Nothing in the
 * type system enforces the ordering, so it is asserted by a test instead; see
 * scheduled-order.test.ts.
 *
 * The purge runs even if the backup pass threw. A backup failing is not a
 * reason to stop deleting old spam -- the backup pass records its own failure
 * on the mailbox, and leaving the purge undone as well would mean one broken
 * mailbox quietly stops both jobs for every mailbox behind it in the loop.
 * What the purge may delete does depend on the backups, though: for a mailbox
 * with backups on, only what an archive in the bucket already holds. The
 * order alone promised that and did not deliver it on a night the backup
 * failed or was not due; see spam-purge-run.ts.
 *
 * The run also writes down that it happened; see maintenance-record.ts. Each
 * pass records its outcome on the mailboxes it touched, which answers "did my
 * backup run" but not "did the run finish" -- and those came apart in
 * production, where the backup recorded a success and the purge recorded
 * nothing at all, ever.
 */

import type { BackupPassSummary, BackupProgress } from "./backup-run";
import { recordBackupNotRun } from "./backup-run";
import { within } from "./deadline";
import type { UnfinishedDeletionsSummary } from "./mailbox-destroy";
import { finishUnfinishedDeletions } from "./mailbox-destroy";
import type { NightLimits, NightRunner, NightStatus } from "./mailbox-night";
import {
	alarmNights,
	nightFor,
	nightHasWork,
	partSettled,
} from "./mailbox-night";
import type { MailboxRecord } from "./mailbox-records";
import { listMailboxes } from "./mailbox-records";
import type { MaintenanceRecord } from "./maintenance-record";
import { archiveLastRun, writeMaintenanceRecord } from "./maintenance-record";
import type { SpamPurgeSummary } from "./spam-purge-run";
import type { Env } from "./types";

export interface MaintenanceSummary {
	backups?: BackupPassSummary;
	spamPurge?: SpamPurgeSummary;
	unfinishedDeletions?: UnfinishedDeletionsSummary;
	backupError?: string;
}

const message = (e: unknown): string =>
	String(e instanceof Error ? e.message : e).slice(0, 300);

/**
 * The runtime ends a cron invocation at fifteen minutes of wall time, and says
 * nothing when it does: on 2026-09-22 the run was `exceededWallTime` at
 * 899968 ms.
 *
 * The cron does none of the mailboxes' work itself any more -- each mailbox's
 * night runs in its own alarm, with its own ends (mailbox-night.ts) -- but it
 * waits for them, to write down how they went, and it must stop waiting in
 * time to write that and finish the deletions left unfinished. Fourteen
 * minutes in, past the nights' own last moment of thirteen and a half; the
 * deletions by fourteen and a half.
 */
export const WAIT_BY_MS = 14 * 60_000;
export const DELETIONS_BY_MS = 14.5 * 60_000;

/** How long a write of the record itself may take before it is let go. */
const NOTE_LIMIT_MS = 10_000;
/** How long one question to a mailbox about its night may take. */
const ASK_LIMIT_MS = 10_000;
/** How often the nights are asked how they are going: soon, then every few seconds. */
const FIRST_POLL_MS = 500;
const POLL_EVERY_MS = 5_000;

export interface MaintenanceLimits extends NightLimits {
	/**
	 * Where the mailboxes' nights run. The scheduled handler leaves it as
	 * it is -- each in its own object's alarm. A test that hands the run an
	 * `env` of its own passes inlineNights, so the nights see that `env`.
	 */
	nights?: (env: Env, limits: NightLimits) => NightRunner;
	waitByMs?: number;
	deletionsByMs?: number;
	/** How often to ask; tests shrink it. */
	pollMs?: number;
}

/**
 * The run is written down as it goes, not summarised at the end.
 *
 * Recording only on completion would record nothing at all in the one case
 * worth recording -- an invocation that does not reach its end. So the record
 * is put at the start with no ending, and updated as each pass finishes; what
 * is missing from it afterwards is the finding. Failing to write it must not
 * take the run down with it, which is the whole point of a diagnostic.
 */
async function note(
	env: Env,
	record: MaintenanceRecord,
): Promise<MaintenanceRecord> {
	// Bounded as well: a write that hangs here would hold the run exactly as
	// a hung backup did.
	await within(
		writeMaintenanceRecord(env, record),
		NOTE_LIMIT_MS,
		"writing the maintenance record",
	).catch(() => {});
	return record;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runScheduledMaintenance(
	env: Env,
	now: Date = new Date(),
	limits: MaintenanceLimits = {},
): Promise<MaintenanceSummary> {
	// The budget runs from when this invocation started, which is not `now`:
	// a test passes a fixed date for what the nights compare against.
	const started = Date.now();
	const waitBy = started + (limits.waitByMs ?? WAIT_BY_MS);
	const deletionsBy = started + (limits.deletionsByMs ?? DELETIONS_BY_MS);
	const runner = (limits.nights ?? alarmNights)(env, limits);

	const summary: MaintenanceSummary = {};
	// Last night's record moves into the history before tonight's replaces
	// it; see maintenance-record.ts.
	await within(
		archiveLastRun(env),
		NOTE_LIMIT_MS,
		"keeping the last run's record",
	).catch(() => {});
	const record: MaintenanceRecord = { startedAt: now.toISOString() };
	await note(env, record);

	let failure: unknown;
	try {
		await runNights(env, now, runner, record, summary, waitBy, limits);
	} catch (e) {
		// Not even the list of mailboxes: both passes say so, and the run
		// still ends, with the deletions done.
		failure = e;
		summary.backupError = message(e);
		const at = new Date().toISOString();
		const nothing = { considered: 0, ran: 0, failed: 0 };
		record.backups ??= { finishedAt: at, ...nothing, error: message(e) };
		await note(env, record);
		record.spamPurge ??= {
			finishedAt: at,
			...nothing,
			deleted: 0,
			error: message(e),
		};
		await note(env, record);
	}

	// Whatever the nights did: a deletion left half done is somebody's mail
	// still stored after they were deleted, and nothing else finishes it.
	try {
		summary.unfinishedDeletions = await finishUnfinishedDeletions(env, {
			deadline: deletionsBy,
		});
		record.unfinishedDeletions = summary.unfinishedDeletions;
	} catch (e) {
		record.unfinishedDeletions = { finished: 0, left: -1, error: message(e) };
	}

	record.finishedAt = new Date().toISOString();
	await note(env, record);
	if (failure !== undefined) throw failure;
	return summary;
}

/**
 * Starts every mailbox's night and waits for them, writing down where they
 * have got to as they go: the backup that is furthest from done, then the
 * backups' summary once every backup has ended, then the purge's.
 *
 * The backups' summary is written on its own before the purge's even when
 * both end at once. A record holding the one and not the other is what says
 * a run stopped between them; the screen that reads it was built on that
 * (maintenance.ts on the dashboard), and so was this record before the
 * nights ran on their own.
 */
async function runNights(
	env: Env,
	now: Date,
	runner: NightRunner,
	record: MaintenanceRecord,
	summary: MaintenanceSummary,
	waitBy: number,
	limits: MaintenanceLimits,
): Promise<void> {
	const mailboxes = await within(
		listMailboxes(env),
		ASK_LIMIT_MS * 6,
		"listing mailboxes",
	);
	const nights = new Map<string, NightStatus>();
	const records = new Map<string, MailboxRecord>();
	for (const mailbox of mailboxes) {
		const night = nightFor(mailbox, now);
		if (!nightHasWork(night)) continue;
		nights.set(mailbox.id, night);
		records.set(mailbox.id, mailbox);
	}
	const dueBackups = [...nights.values()]
		.filter((night) => night.backup.state !== "skipped")
		.map((night) => night.mailbox);

	// Every night begun at once; one that will not start is failed here, on
	// its mailbox as well, so its screen does not go on showing last night.
	await Promise.all(
		[...nights.keys()].map(async (id) => {
			try {
				await within(
					runner.start(records.get(id) as MailboxRecord, now),
					ASK_LIMIT_MS,
					"starting the mailbox's night",
				);
			} catch (e) {
				const night = nights.get(id) as NightStatus;
				if (night.backup.state !== "skipped") {
					await recordBackupNotRun(
						env,
						id,
						now,
						`Could not be started: ${message(e)}`,
					);
				}
				nights.set(id, {
					...night,
					state: "done",
					backup: {
						state: night.backup.state === "skipped" ? "skipped" : "failed",
					},
					purge: {
						state: night.purge.state === "skipped" ? "skipped" : "failed",
					},
				});
			}
		}),
	);

	// Which backups are due and in what order, before any has said anything:
	// a run ended right after starting them still names them.
	let lastProgress = "";
	const begun = furthestFromDone(nights, dueBackups);
	if (begun) {
		lastProgress = JSON.stringify(begun);
		record.backupProgress = begun;
		await note(env, record);
	}

	const settledBackups = () =>
		[...nights.values()].every((night) => partSettled(night.backup.state));
	const allDone = () =>
		[...nights.values()].every((night) => night.state === "done");

	let pause = limits.pollMs ?? FIRST_POLL_MS;
	while (true) {
		if (settledBackups() && !record.backups) {
			summary.backups = backupSummary(mailboxes.length, nights);
			record.backups = {
				finishedAt: new Date().toISOString(),
				...summary.backups,
			};
			await note(env, record);
		}
		if (allDone()) break;
		if (Date.now() >= waitBy) break;

		await sleep(Math.min(pause, Math.max(0, waitBy - Date.now())));
		pause = Math.min(pause * 2, limits.pollMs ?? POLL_EVERY_MS);

		await Promise.all(
			[...nights.entries()]
				.filter(([, night]) => night.state !== "done")
				.map(async ([id]) => {
					const status = await within(
						runner.status(id, now),
						ASK_LIMIT_MS,
						"asking a mailbox how its night is going",
					).catch(() => null);
					if (status) nights.set(id, status);
				}),
		);

		const progress = furthestFromDone(nights, dueBackups);
		const seen = JSON.stringify(progress);
		if (progress && seen !== lastProgress && !record.backups) {
			lastProgress = seen;
			record.backupProgress = progress;
			await note(env, record);
		}
	}

	// Still under way when the wait ended: counted as failed here. The night
	// itself goes on and records how it ends on its own mailbox.
	if (!record.backups) {
		summary.backups = backupSummary(mailboxes.length, nights);
		record.backups = {
			finishedAt: new Date().toISOString(),
			...summary.backups,
		};
		await note(env, record);
	}
	summary.spamPurge = purgeSummary(mailboxes.length, nights);
	record.spamPurge = {
		finishedAt: new Date().toISOString(),
		...summary.spamPurge,
	};
	await note(env, record);
}

function backupSummary(
	considered: number,
	nights: Map<string, NightStatus>,
): BackupPassSummary {
	const states = [...nights.values()].map((night) => night.backup.state);
	return {
		considered,
		ran: states.filter((state) => state === "ran").length,
		failed: states.filter((state) => state !== "skipped" && state !== "ran")
			.length,
	};
}

function purgeSummary(
	considered: number,
	nights: Map<string, NightStatus>,
): SpamPurgeSummary {
	const purges = [...nights.values()].map((night) => night.purge);
	return {
		considered,
		ran: purges.filter((purge) => purge.state === "ran").length,
		deleted: purges.reduce((sum, purge) => sum + (purge.deleted ?? 0), 0),
		failed: purges.filter(
			(purge) => purge.state !== "skipped" && purge.state !== "ran",
		).length,
	};
}

/**
 * The backup still under way that has written the least, as the record's
 * progress: the one a run cut off now would most likely be cut off in. Its
 * place is its position among the due backups, which are all under way at
 * once now rather than one after another.
 */
function furthestFromDone(
	nights: Map<string, NightStatus>,
	dueBackups: string[],
): (BackupProgress & { at?: string }) | undefined {
	const open = dueBackups
		.map((id) => nights.get(id) as NightStatus)
		.filter((night) => !partSettled(night.backup.state));
	if (open.length === 0) return undefined;
	const least = open.reduce((a, b) =>
		(b.backup.messages ?? 0) < (a.backup.messages ?? 0) ? b : a,
	);
	return {
		mailbox: least.mailbox,
		index: dueBackups.indexOf(least.mailbox) + 1,
		of: dueBackups.length,
		messages: least.backup.messages ?? 0,
		...(least.backup.at ? { at: least.backup.at } : {}),
	};
}
