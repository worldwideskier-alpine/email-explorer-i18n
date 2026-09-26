import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledSpamPurge } from "../../src/spam-purge-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The scheduled pass that empties the back of the spam folder.
 *
 * What it deletes is gone -- no trash, no undo -- so these run against the
 * real ingest path and the real bucket rather than against the decision
 * function, which has its own tests. The question here is whether the right
 * rows and the right objects go, and whether everything else stays.
 */

const NOW = new Date("2026-09-01T18:00:00.000Z");

/**
 * Puts a message in a folder with a date of its own, through the same
 * endpoint a restore from a backup uses. Nothing else can produce a message
 * that is already a month old, and a test back door into the database would
 * be testing something other than what runs.
 */
async function place(subject: string, folder: string, date: string) {
	const raw = [
		"From: sender@spoofed.invalid",
		`To: ${mailboxId}`,
		`Subject: ${subject}`,
		`Date: ${date}`,
		"Content-Type: text/plain; charset=UTF-8",
		"",
		"body",
	].join("\r\n");

	const res = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				folder,
				date,
				rawEmailBase64: btoa(
					String.fromCharCode(...new TextEncoder().encode(raw)),
				),
			}),
		},
	);
	expect(res.status, `importing ${subject}`).toBe(201);
	const { id } = await res.json<{ id: string }>();
	if (folder === "spam") {
		// In spam since its date, as a message that old would have been. The
		// import itself files it as spam as of now, which is when a restore
		// puts it there.
		// @ts-expect-error test binding
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		await runInDurableObject(stub, async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET spam_since = ? WHERE id = ?",
				date,
				id,
			);
		});
	}
	return id;
}

async function subjectsIn(folder: string): Promise<string[]> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
	);
	return (await res.json<{ subject: string }[]>()).map((e) => e.subject);
}

async function setRetention(settings: Record<string, unknown>) {
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ settings: { spamRetention: settings } }),
	});
}

async function storedSettings() {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}`,
	);
	return (
		await res.json<{
			settings: {
				spamRetention?: {
					days?: number;
					lastRunAt?: string;
					lastResult?: { ok: boolean; deleted?: number };
				};
			};
		}>()
	).settings;
}

describe("deleting old mail out of the spam folder", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("takes the old spam and leaves the rest of it", async () => {
		await place("Old spam", "spam", "2026-07-01T00:00:00.000Z");
		await place("Recent spam", "spam", "2026-08-30T00:00:00.000Z");
		await setRetention({ enabled: true, days: 30 });

		const summary = await runScheduledSpamPurge(env as never, NOW);

		expect(summary.deleted).toBe(1);
		expect(await subjectsIn("spam")).toEqual(["Recent spam"]);
	});

	/**
	 * Retention runs from when a message became spam. Counted from its date,
	 * an old message filed as spam today was gone by the next night -- with
	 * backups off, before anyone could notice the mistake and take it back.
	 */
	it("counts from when a message was filed as spam, not from its date", async () => {
		const filed = await place(
			"Old, filed today",
			"inbox",
			"2026-01-01T00:00:00.000Z",
		);
		const moved = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${filed}/move`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ folderId: "spam" }),
			},
		);
		expect(moved.status).toBe(200);
		await setRetention({ enabled: true, days: 30 });

		// Filed on the real clock, which is after NOW; either way, not 30 days
		// before it.
		await runScheduledSpamPurge(env as never, NOW);

		expect(await subjectsIn("spam")).toEqual(["Old, filed today"]);
	});

	/**
	 * The folder matters as much as the date. Old mail in the inbox, the
	 * archive, or a folder the user made is mail somebody chose to keep.
	 */
	it("does not touch any folder but spam", async () => {
		const old = "2026-01-01T00:00:00.000Z";
		await place("Old inbox", "inbox", old);
		await place("Old archive", "archive", old);
		await place("Old trash", "trash", old);
		await place("Old spam", "spam", old);
		await setRetention({ enabled: true, days: 30 });

		await runScheduledSpamPurge(env as never, NOW);

		expect(await subjectsIn("spam")).toEqual([]);
		expect(await subjectsIn("inbox")).toContain("Old inbox");
		expect(await subjectsIn("archive")).toContain("Old archive");
		expect(await subjectsIn("trash")).toContain("Old trash");
	});

	// The stored message body is in the bucket, not the database. A row
	// deleted without it leaves an object nothing can ever reach again, which
	// is billed monthly and never found.
	it("takes the stored copy of the message with it", async () => {
		const id = await place("Old spam", "spam", "2026-07-01T00:00:00.000Z");
		const bucket = (env as unknown as { BUCKET: R2Bucket }).BUCKET;
		expect(await bucket.head(`raw/${id}.eml`)).not.toBeNull();

		await setRetention({ enabled: true, days: 30 });
		await runScheduledSpamPurge(env as never, NOW);

		expect(await bucket.head(`raw/${id}.eml`)).toBeNull();
	});

	it("does nothing at all to a mailbox that has not asked for it", async () => {
		await place("Old spam", "spam", "2026-01-01T00:00:00.000Z");

		const summary = await runScheduledSpamPurge(env as never, NOW);

		expect(summary.ran).toBe(0);
		expect(await subjectsIn("spam")).toEqual(["Old spam"]);
	});

	it("stops deleting when it is switched off again", async () => {
		await place("Old spam", "spam", "2026-01-01T00:00:00.000Z");
		await setRetention({ enabled: true, days: 30 });
		await setRetention({ enabled: false, days: 30 });

		await runScheduledSpamPurge(env as never, NOW);

		expect(await subjectsIn("spam")).toEqual(["Old spam"]);
	});

	/**
	 * A purge that has quietly stopped running looks exactly like one finding
	 * nothing to delete: a spam folder nobody opens. The run records itself
	 * for the same reason the backup does.
	 */
	it("records what it did on the mailbox", async () => {
		await place("Old spam", "spam", "2026-07-01T00:00:00.000Z");
		await setRetention({ enabled: true, days: 30 });

		await runScheduledSpamPurge(env as never, NOW);

		const { spamRetention } = await storedSettings();
		expect(spamRetention?.lastRunAt).toBe(NOW.toISOString());
		expect(spamRetention?.lastResult).toMatchObject({ ok: true, deleted: 1 });
	});

	// Recording the run must not undo the setting that caused it.
	it("leaves the setting alone while recording the run", async () => {
		await setRetention({ enabled: true, days: 45 });
		await runScheduledSpamPurge(env as never, NOW);

		const { spamRetention } = await storedSettings();
		expect(spamRetention?.days).toBe(45);
	});

	/**
	 * The number of days may be lowered, unlike the backup retention count
	 * beside it -- that one may only rise because rotation is the only thing
	 * that deletes an archive. What this deletes is spam, and the backup pass
	 * has already written it out.
	 */
	it("lets the retention be shortened", async () => {
		await setRetention({ enabled: true, days: 90 });
		await setRetention({ enabled: true, days: 7 });
		expect((await storedSettings()).spamRetention?.days).toBe(7);
	});

	// The dangerous input: a cleared number field arrives as an empty string,
	// and reading that as zero would mean one day.
	it("does not read a cleared field as one day", async () => {
		await setRetention({ enabled: true, days: "" });
		expect((await storedSettings()).spamRetention?.days).toBe(30);
	});
});

/**
 * With backups on, the purge deletes only what an archive holds.
 *
 * Running after the backup pass promised that and did not deliver it: the
 * backup can fail, be cut off (it was, two nights running), or not be due --
 * a weekly or monthly backup is not taken every night, and a message can
 * arrive and expire between two of them. Each case below is one where a
 * message would have been deleted with no copy anywhere.
 */
/**
 * When a message arrived, as the mailbox recorded it. Ingest stamps the real
 * clock; these tests run the purge at a fixed NOW, so the arrival is set to
 * match the story each test tells.
 */
async function arrivedAt(id: string, iso: string) {
	// @ts-expect-error test binding
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await runInDurableObject(stub, async (_i, state) => {
		state.storage.sql.exec(
			"UPDATE emails SET received_at = ? WHERE id = ?",
			iso,
			id,
		);
	});
}

describe("deleting old spam when backups are on", () => {
	const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
	const archive = (stamp: string) =>
		bucket().put(`backups/${encodeURIComponent(mailboxId)}/${stamp}.mbox`, "x");

	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: {
						autoBackup: { enabled: true, frequency: "monthly", keep: 3 },
					},
				}),
			},
		);
	});

	it("deletes nothing before there is any archive", async () => {
		await place("Old spam", "spam", "2026-07-01T00:00:00.000Z");
		await setRetention({ enabled: true, days: 30 });

		const summary = await runScheduledSpamPurge(env as never, NOW);

		expect(summary.deleted).toBe(0);
		expect(await subjectsIn("spam")).toEqual(["Old spam"]);
		expect((await storedSettings()).spamRetention?.lastResult).toMatchObject({
			ok: true,
			deleted: 0,
		});
	});

	it("deletes what arrived before the newest archive and keeps what came after", async () => {
		await archive("2026-07-15T18-00-00-000Z");
		await archive("2026-08-10T18-00-00-000Z");
		const inArchive = await place(
			"In the archive",
			"spam",
			"2026-08-01T00:00:00.000Z",
		);
		await arrivedAt(inArchive, "2026-08-01T00:00:00.000Z");
		const after = await place(
			"After the archive",
			"spam",
			"2026-08-20T00:00:00.000Z",
		);
		await arrivedAt(after, "2026-08-20T00:00:00.000Z");
		const recent = await place("Recent", "spam", "2026-08-31T00:00:00.000Z");
		await arrivedAt(recent, "2026-08-31T00:00:00.000Z");
		await setRetention({ enabled: true, days: 7 });

		const summary = await runScheduledSpamPurge(env as never, NOW);

		expect(summary.deleted).toBe(1);
		expect((await subjectsIn("spam")).sort()).toEqual([
			"After the archive",
			"Recent",
		]);
	});

	it("goes by the newest archive, not the first one listed", async () => {
		for (let day = 1; day <= 28; day++) {
			const d = String(day).padStart(2, "0");
			await archive(`2026-06-${d}T18-00-00-000Z`);
		}
		await archive("2026-08-25T18-00-00-000Z");
		const covered = await place("Covered", "spam", "2026-08-20T00:00:00.000Z");
		await arrivedAt(covered, "2026-08-20T00:00:00.000Z");
		await setRetention({ enabled: true, days: 7 });

		expect((await runScheduledSpamPurge(env as never, NOW)).deleted).toBe(1);
	});

	/**
	 * A restored message carries its own old date. Old by that date is not
	 * the same as archived: it arrived after the newest archive, so no archive
	 * holds it yet. Compared by date, it was deleted with no copy anywhere.
	 */
	it("keeps a restored message with an old date until an archive holds it", async () => {
		await archive("2026-08-25T18-00-00-000Z");
		const restored = await place(
			"Restored",
			"spam",
			"2025-01-01T00:00:00.000Z",
		);
		await arrivedAt(restored, "2026-08-30T00:00:00.000Z");
		await setRetention({ enabled: true, days: 7 });

		expect((await runScheduledSpamPurge(env as never, NOW)).deleted).toBe(0);
		expect(await subjectsIn("spam")).toEqual(["Restored"]);
	});

	/**
	 * The purge lists its messages and then deletes them one at a time. One
	 * rescued from spam in between is in the inbox now, and stays there.
	 */
	it("leaves a message rescued while the purge is running", async () => {
		await archive("2026-08-25T18-00-00-000Z");
		const rescued = await place("Rescued", "spam", "2026-08-01T00:00:00.000Z");
		await arrivedAt(rescued, "2026-08-01T00:00:00.000Z");
		await setRetention({ enabled: true, days: 7 });

		// The mailbox answers the purge's listing, and the message is moved to
		// the inbox straight after -- the reader said "not spam" meanwhile.
		// @ts-expect-error test binding
		const ns = env.MAILBOX;
		const racing = new Proxy(ns, {
			get(target, property) {
				if (property !== "get") {
					const member = Reflect.get(target, property);
					return typeof member === "function" ? member.bind(target) : member;
				}
				return (id: DurableObjectId) => {
					const stub = target.get(id);
					return new Proxy(stub, {
						get(s, p) {
							if (p !== "listSpamEmailDates") return Reflect.get(s, p);
							return async () => {
								const listed = await s.listSpamEmailDates();
								await s.moveEmail(rescued, "inbox");
								return listed;
							};
						},
					});
				};
			},
		});

		const summary = await runScheduledSpamPurge(
			{ ...(env as object), MAILBOX: racing } as never,
			NOW,
		);
		expect(summary).toMatchObject({ ran: 1, failed: 0, deleted: 0 });
		expect(await subjectsIn("inbox")).toContain("Rescued");
	});

	it("does not delete a message that has left the spam folder", async () => {
		await archive("2026-08-25T18-00-00-000Z");
		const rescued = await place("Rescued", "spam", "2026-08-01T00:00:00.000Z");
		await arrivedAt(rescued, "2026-08-01T00:00:00.000Z");
		// @ts-expect-error test binding
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		expect(await stub.deleteEmail(rescued, "spam")).not.toBeNull();
		const again = await place("Moved", "spam", "2026-08-01T00:00:00.000Z");
		await stub.moveEmail(again, "inbox");
		expect(await stub.deleteEmail(again, "spam")).toBeNull();
		expect(await subjectsIn("inbox")).toContain("Moved");
	});

	it("still deletes by date alone when backups are off", async () => {
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings: { autoBackup: { enabled: false } } }),
			},
		);
		await place("Old spam", "spam", "2026-07-01T00:00:00.000Z");
		await setRetention({ enabled: true, days: 30 });

		expect((await runScheduledSpamPurge(env as never, NOW)).deleted).toBe(1);
	});
});
