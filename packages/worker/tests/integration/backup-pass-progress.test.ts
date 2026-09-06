import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BackupProgress } from "../../src/backup-run";
import { runScheduledBackups } from "../../src/backup-run";
import { writeMailboxBackup } from "../../src/backup-writer";
import { runScheduledMaintenance } from "../../src/scheduled-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The nightly run stopped finishing, and left nothing behind that said where.
 *
 * The record for 2026-09-04 on the live deployment was, in full:
 *
 *   {"startedAt":"2026-09-03T18:14:09.407Z"}
 *
 * `scheduled-run.ts` writes `backups` whether the pass returns or throws, so
 * its absence means the runtime cut the invocation off *inside* the backup
 * pass. No archive had been written for two nights, and the spam purge --
 * second in the order -- had never once recorded anything. One fault, three
 * symptoms.
 *
 * What the record could not say is which mailbox and how far in, which is the
 * difference between one mailbox being too large to finish and the pass never
 * reaching the ones at the back of the list. These hold the two things that
 * answer it: the pass reports as it goes, and it takes the most overdue
 * mailbox first so being at the back is not permanent.
 */

async function setAutoBackup(
	id: string,
	settings: { enabled: boolean; frequency?: string; lastRunAt?: string },
) {
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			settings: { autoBackup: { frequency: "daily", keep: 5, ...settings } },
		}),
	});
}

async function makeMailbox(id: string) {
	await authenticatedFetch("http://local.test/api/v1/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: id, name: id }),
	});
}

/**
 * Puts `count` messages in the mailbox, in a known order.
 *
 * One request each, because that is what the import endpoint takes -- which
 * makes 150 of them slow but is the only way to get a mailbox past one page.
 */
async function fill(id: string, count: number) {
	for (let i = 0; i < count; i++) {
		const subject = `message ${String(i).padStart(4, "0")}`;
		// Ascending, so date order and subject order are the same order.
		const date = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
		const raw = [
			"From: sender@legit.test",
			`To: ${id}`,
			`Subject: ${subject}`,
			`Date: ${date}`,
			"Content-Type: text/plain; charset=UTF-8",
			"",
			`body ${i}`,
		].join("\r\n");

		const res = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${id}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					folder: "inbox",
					date,
					rawEmailBase64: btoa(
						String.fromCharCode(...new TextEncoder().encode(raw)),
					),
				}),
			},
		);
		expect(res.status, `importing ${subject}`).toBe(201);
	}
}

describe("the backup pass says where it is", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * Reported before each mailbox is opened, not only after it is finished.
	 * A report that arrives on completion says nothing about the run that does
	 * not complete, which is the only run this exists for.
	 */
	it("names the mailbox and its place before starting on it", async () => {
		await setAutoBackup(mailboxId, { enabled: true });
		await fill(mailboxId, 3);

		const seen: BackupProgress[] = [];
		const summary = await runScheduledBackups(env, new Date(), async (p) => {
			seen.push(p);
		});

		expect(summary.ran).toBe(1);
		expect(seen[0]).toEqual({
			mailbox: mailboxId,
			index: 1,
			of: 1,
			messages: 0,
		});
	});

	/**
	 * The most overdue mailbox goes first.
	 *
	 * The order used to be whatever the mailbox list gave back. That is fine
	 * only while every mailbox gets its turn -- and once an invocation stops
	 * finishing, the ones at the front are backed up every night and the ones
	 * behind them never again, silently. Sorting by when each last ran makes a
	 * mailbox missed tonight the first one tried tomorrow.
	 */
	it("starts with the mailbox that has waited longest", async () => {
		const recent = "recent@example.test";
		await makeMailbox(recent);
		await setAutoBackup(recent, { enabled: true });

		// A real run, because `lastRunAt` is not something a client may set --
		// it is written by the pass itself, which is the whole of its meaning.
		const first = new Date("2026-09-01T18:00:00.000Z");
		await runScheduledBackups(env, first);

		// And now one that has never been backed up at all, which has therefore
		// been waiting longer than any date could say.
		await setAutoBackup(mailboxId, { enabled: true });

		const order: string[] = [];
		const later = new Date("2026-09-02T18:00:00.000Z");
		await runScheduledBackups(env, later, async (p) => {
			if (p.messages === 0) order.push(p.mailbox);
		});

		expect(order).toEqual([mailboxId, recent]);
	});

	// A mailbox that is not due is not in the count the positions are against.
	it("counts only the mailboxes it is going to do", async () => {
		const skipped = "skipped@example.test";
		await makeMailbox(skipped);
		await setAutoBackup(skipped, { enabled: false });
		await setAutoBackup(mailboxId, { enabled: true });

		const seen: BackupProgress[] = [];
		await runScheduledBackups(env, new Date(), async (p) => {
			seen.push(p);
		});

		expect(seen.map((p) => [p.mailbox, p.of])).toEqual([[mailboxId, 1]]);
	});

	/**
	 * And the report cannot take the backup down with it. It exists to explain
	 * a run that failed; a diagnostic that turns a working run into a failed
	 * one is worse than none.
	 */
	it("still backs up when the reporting throws", async () => {
		await setAutoBackup(mailboxId, { enabled: true });
		await fill(mailboxId, 3);

		const summary = await runScheduledBackups(env, new Date(), async () => {
			throw new Error("the diagnostic is broken");
		});

		expect([summary.ran, summary.failed]).toEqual([1, 0]);
	});
});

describe("the run writes down where it got to", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * End to end: the record a root screen reads carries the progress. On a run
	 * that finishes it is simply the last thing the pass said; on one that is
	 * cut off it is the only thing there is.
	 */
	it("puts the progress in the maintenance record", async () => {
		await setAutoBackup(mailboxId, { enabled: true });
		await fill(mailboxId, 3);

		await runScheduledMaintenance(env, new Date());

		const stored = await env.BUCKET.get("maintenance/last-run.json");
		const record = await stored?.json<{
			backupProgress?: { mailbox: string; index: number; of: number };
		}>();

		expect(record?.backupProgress).toMatchObject({
			mailbox: mailboxId,
			index: 1,
			of: 1,
		});
	});
});

/**
 * Reading the messages a page at a time rather than one round trip each.
 *
 * Over 1500 round trips to one Durable Object, inside an invocation that also
 * does an R2 read per message, is the cost that made the run stop finishing.
 * The archive it produces must be the one it produced before -- same messages,
 * same order -- which is what these check, across more than one page.
 */
describe("reading a page at a time", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("returns the rows in the order they were asked for", async () => {
		await fill(mailboxId, 5);
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const ids = await stub.listEmailIdsByDate();

		const backwards = [...ids].reverse();
		const rows = await stub.getEmailsByIds(backwards);

		// `IN (...)` promises nothing about order, and the archive is written
		// in date order, so the caller's order is the one that has to survive.
		expect(rows.map((row) => String(row.id))).toEqual(backwards);
	});

	it("skips an id with no row rather than returning a hole", async () => {
		await fill(mailboxId, 2);
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const ids = await stub.listEmailIdsByDate();

		const rows = await stub.getEmailsByIds([
			ids[0] as string,
			"no-such-email",
			ids[1] as string,
		]);

		expect(rows.map((row) => String(row.id))).toEqual([ids[0], ids[1]]);
	});

	it("answers nothing for nothing", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		expect(await stub.getEmailsByIds([])).toEqual([]);
	});

	/**
	 * The archive across a page boundary. A hundred is the page size, so this
	 * is the first count that reads more than one page, and an off-by-one at
	 * the seam would drop or repeat a message -- invisibly, in a file nobody
	 * opens until they need it.
	 */
	it("writes every message when there is more than one page", async () => {
		await setAutoBackup(mailboxId, { enabled: true });
		await fill(mailboxId, 150);

		const summary = await runScheduledBackups(env, new Date());
		expect(summary.ran).toBe(1);

		const listed = await env.BUCKET.list({
			prefix: `backups/${encodeURIComponent(mailboxId)}/`,
		});
		const archive = await env.BUCKET.get(listed.objects[0]?.key as string);
		const text = await archive?.text();

		expect(text?.match(/^From /gm)?.length).toBe(150);

		/*
		 * Every subject, in the order the archive holds them, against the order
		 * the ids were taken in. Spot checks at the seam pass on an archive in
		 * which each group of twelve came out reversed: the messages are all
		 * there and the boundaries are all right, and the archive is wrong. The
		 * renders are concurrent now, so the only assertion worth making about
		 * the order is the whole of it.
		 */
		const order = [
			...(text?.matchAll(/^Subject: (message \d{4})$/gm) ?? []),
		].map((m) => m[1]);
		expect(order).toEqual(
			Array.from(
				{ length: 150 },
				(_, n) => `message ${String(n).padStart(4, "0")}`,
			),
		);
	} /*
	 * Measured at 3.0s running this file alone, against vitest's default of
	 * 5s -- 1.7x of headroom, which is none. The full suite is 62 files on
	 * one worker, and there it went over and took the deploy down with it.
	 *
	 * The cost is real and is the test: 150 imports, one request each,
	 * because that is what the endpoint takes and a hundred is the page
	 * size. Making the count smaller to fit a budget would buy the time by
	 * giving up the seam this exists to cover, so the budget is what moves.
	 */, 30_000);

	/**
	 * And more than one message is in flight at a time.
	 *
	 * The rows were already read a page at a time; the renders were not, and
	 * each waited on its own bucket read before the next one started. The
	 * archive that comes out is identical either way, so nothing above this
	 * can tell the two apart -- and the difference on the live deployment was
	 * a run that finished in 8m45s and one killed 12m30s in.
	 *
	 * Counted rather than timed: the bucket under the test answers at once, so
	 * a stopwatch here would measure nothing. The small delay is what makes an
	 * overlap observable at all.
	 */
	it("reads more than one message at a time", async () => {
		await setAutoBackup(mailboxId, { enabled: true });
		await fill(mailboxId, 30);

		let inFlight = 0;
		let peak = 0;
		const watched = {
			...env,
			BUCKET: new Proxy(env.BUCKET, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") return value;
					if (prop !== "get") return value.bind(target);
					return async (...args: unknown[]) => {
						inFlight += 1;
						peak = Math.max(peak, inFlight);
						try {
							await new Promise((done) => setTimeout(done, 5));
							return await value.apply(target, args);
						} finally {
							inFlight -= 1;
						}
					};
				},
			}),
		} as typeof env;

		const written = await writeMailboxBackup(watched, mailboxId, new Date(), 5);

		expect(written.messages).toBe(30);
		expect(peak).toBeGreaterThan(1);
	}, 30_000);
});
