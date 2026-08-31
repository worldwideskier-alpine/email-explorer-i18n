import { env } from "cloudflare:test";
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
	return (await res.json<{ id: string }>()).id;
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
