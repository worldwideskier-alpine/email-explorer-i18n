import {
	createExecutionContext,
	createScheduledController,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledBackups } from "../../src/backup-run";
import { listBackups } from "../../src/backup-writer";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The scheduled pass, end to end against a real R2 binding: writing the
 * archive, rotating the old ones out, and recording what happened.
 */

const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;

function rawEmail(subject: string): string {
	return Buffer.from(
		[
			"From: sender@example.org",
			`To: ${mailboxId}`,
			`Subject: ${subject}`,
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			"body",
			"",
		].join("\r\n"),
		"utf8",
	).toString("base64");
}

const importEmail = async (subject: string, folder = "inbox") =>
	authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder, rawEmailBase64: rawEmail(subject) }),
		},
	);

async function setBackup(settings: Record<string, unknown>): Promise<void> {
	const key = `mailboxes/${mailboxId}.json`;
	const stored = await bucket().get(key);
	const current = stored ? ((await stored.json()) as Record<string, unknown>) : {};
	await bucket().put(
		key,
		JSON.stringify({ ...current, autoBackup: settings }),
	);
}

async function readBackupSettings(): Promise<Record<string, any>> {
	const stored = await bucket().get(`mailboxes/${mailboxId}.json`);
	return ((await stored?.json()) as Record<string, any>)?.autoBackup ?? {};
}

describe("The scheduled backup pass", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("skips a mailbox that has not turned it on", async () => {
		await importEmail("one");
		const summary = await runScheduledBackups(env as never, new Date());

		expect(summary.ran).toBe(0);
		expect(await listBackups(env as never, mailboxId)).toEqual([]);
	});

	it("writes an archive holding the mail, and says so", async () => {
		await importEmail("first");
		await importEmail("second", "sent");
		await setBackup({ enabled: true, frequency: "daily", keep: 3 });

		const summary = await runScheduledBackups(env as never, new Date());
		expect(summary).toMatchObject({ ran: 1, failed: 0 });

		const stored = await listBackups(env as never, mailboxId);
		expect(stored).toHaveLength(1);

		const object = await bucket().get(
			`backups/${encodeURIComponent(mailboxId)}/${stored[0].name}`,
		);
		const text = await (object as R2ObjectBody).text();
		expect(text).toContain("Subject: first");
		expect(text).toContain("Subject: second");
		// The archive is a real mbox, carrying what the export carries.
		expect(text).toContain("X-Email-Explorer-Folder: Inbox");
		expect(text).toContain("X-Email-Explorer-Folder: Sent");

		const settings = await readBackupSettings();
		expect(settings.lastResult).toMatchObject({ ok: true, messages: 2 });
		expect(settings.lastRunAt).toBeTypeOf("string");
	});

	it("does not run again until the frequency comes round", async () => {
		await importEmail("one");
		await setBackup({ enabled: true, frequency: "weekly", keep: 5 });

		const first = new Date("2026-09-01T18:00:00.000Z");
		expect((await runScheduledBackups(env as never, first)).ran).toBe(1);

		const nextDay = new Date("2026-09-02T18:00:00.000Z");
		expect((await runScheduledBackups(env as never, nextDay)).ran).toBe(0);

		const nextWeek = new Date("2026-09-08T18:00:00.000Z");
		expect((await runScheduledBackups(env as never, nextWeek)).ran).toBe(1);
		expect(await listBackups(env as never, mailboxId)).toHaveLength(2);
	});

	// This is the only code that removes a backup. There is no endpoint for it.
	it("rotates the oldest out once the retention count is passed", async () => {
		await importEmail("one");
		await setBackup({ enabled: true, frequency: "daily", keep: 2 });

		for (const day of ["01", "02", "03", "04"]) {
			await runScheduledBackups(
				env as never,
				new Date(`2026-09-${day}T18:00:00.000Z`),
			);
		}

		const stored = await listBackups(env as never, mailboxId);
		expect(stored).toHaveLength(2);
		// Newest first, and the two survivors are the newest two.
		expect(stored[0].name.startsWith("2026-09-04")).toBe(true);
		expect(stored[1].name.startsWith("2026-09-03")).toBe(true);

		const settings = await readBackupSettings();
		expect(settings.lastResult.removed).toBe(1);
	});

	/**
	 * The monthly tier, against a real bucket: the mail is destroyed and the
	 * daily backups keep running until the count has turned over several times.
	 * Under rotation by count alone every copy of the mail would be gone.
	 */
	it("still holds a readable archive after the mail is destroyed and the count turns over", async () => {
		await importEmail("the only copy of this");
		await setBackup({ enabled: true, frequency: "daily", keep: 2 });

		// June: the mail is there.
		for (const day of ["01", "02", "03"]) {
			await runScheduledBackups(
				env as never,
				new Date(`2026-06-${day}T18:00:00.000Z`),
			);
		}

		// Someone with a session empties the mailbox.
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { deletionLocked: false } }),
		});
		const purge = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}?purge=true`,
			{ method: "DELETE" },
		);
		expect(purge.status).toBe(204);
		await createDummyMailbox();
		await setBackup({ enabled: true, frequency: "daily", keep: 2 });

		// July: the backups keep running on an empty mailbox, well past `keep`.
		for (const day of ["01", "02", "03", "04", "05"]) {
			await runScheduledBackups(
				env as never,
				new Date(`2026-07-${day}T18:00:00.000Z`),
			);
		}

		const stored = await listBackups(env as never, mailboxId);
		const contents = await Promise.all(
			stored.map(async (backup) => {
				const object = await bucket().get(
					`backups/${encodeURIComponent(mailboxId)}/${backup.name}`,
				);
				return await (object as R2ObjectBody).text();
			}),
		);

		expect(contents.some((text) => text.includes("the only copy of this"))).toBe(
			true,
		);
	});

	it("writes an archive for an empty mailbox rather than nothing at all", async () => {
		await setBackup({ enabled: true, frequency: "daily", keep: 2 });
		expect((await runScheduledBackups(env as never, new Date())).ran).toBe(1);

		// "It ran and there was no mail" has to be distinguishable from
		// "it never ran".
		const stored = await listBackups(env as never, mailboxId);
		expect(stored).toHaveLength(1);
		expect(stored[0].size).toBe(0);
		expect((await readBackupSettings()).lastResult).toMatchObject({
			ok: true,
			messages: 0,
		});
	});

	it("serves the list and the archive over the API", async () => {
		await importEmail("downloadable");
		await setBackup({ enabled: true, frequency: "daily", keep: 2 });
		await runScheduledBackups(env as never, new Date());

		const list = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/backups`,
		);
		expect(list.status).toBe(200);
		const backups = await list.json<{ name: string; size: number }[]>();
		expect(backups).toHaveLength(1);

		const download = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/backups/${backups[0].name}`,
		);
		expect(download.status).toBe(200);
		expect(await download.text()).toContain("Subject: downloadable");
	});

	// This asserts only that an unknown name is a 404, which is all it can:
	// removing the name check in the route leaves it passing. R2 keys are
	// literal, so "backups/box/../../outside.txt" is a key that simply does
	// not exist rather than a step out of the prefix -- measured, not assumed.
	// The name check is a sanity check, not what makes this safe.
	it("answers 404 for a name that is not one of this mailbox's archives", async () => {
		for (const name of [
			"..%2F..%2Fmailboxes%2Fother.json",
			"../../raw/abc.eml",
			"not-an-archive.txt",
		]) {
			const res = await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/backups/${name}`,
			);
			// 403 for the two that walk up out of the mailbox: the path is
			// normalised before routing, so what arrives names a different
			// mailbox, and one that is not this person's is refused. 404 for
			// the name that stays inside and simply is not an archive.
			// Either way there is no archive and no other mailbox's data.
			expect([403, 404]).toContain(res.status);
		}
	});

	// The point of the whole design: an attacker with a session here can
	// destroy the mail, and the copies of it survive.
	it("keeps the archives when the mailbox is purged", async () => {
		await importEmail("precious");
		await setBackup({ enabled: true, frequency: "daily", keep: 3 });
		await runScheduledBackups(env as never, new Date());
		expect(await listBackups(env as never, mailboxId)).toHaveLength(1);

		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings: { deletionLocked: false } }),
			},
		);
		const purge = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}?purge=true`,
			{ method: "DELETE" },
		);
		expect(purge.status).toBe(204);

		const survivors = await listBackups(env as never, mailboxId);
		expect(survivors).toHaveLength(1);
		const object = await bucket().get(
			`backups/${encodeURIComponent(mailboxId)}/${survivors[0].name}`,
		);
		expect(await (object as R2ObjectBody).text()).toContain(
			"Subject: precious",
		);
	});

	it("has no route that deletes a backup", async () => {
		await importEmail("one");
		await setBackup({ enabled: true, frequency: "daily", keep: 3 });
		await runScheduledBackups(env as never, new Date());
		const [backup] = await listBackups(env as never, mailboxId);

		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/backups/${backup.name}`,
			{ method: "DELETE" },
		);
		expect(res.status).not.toBe(200);
		expect(res.status).not.toBe(204);
		expect(await listBackups(env as never, mailboxId)).toHaveLength(1);
	});
});

/**
 * The exported scheduled() handler itself, not just the function it calls.
 *
 * Everything above proves the backup logic; this proves it is actually
 * reachable from a cron. Wiring the handler and configuring the trigger are
 * the two ways this feature can be complete and still never run, and neither
 * shows up in a test of the logic alone.
 */
describe("The scheduled entrypoint", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("backs up a due mailbox when a cron fires", async () => {
		await importEmail("through the cron");
		await setBackup({ enabled: true, frequency: "daily", keep: 2 });

		const worker = (await import("../../dev/index")).default as {
			scheduled?: (
				controller: ScheduledController,
				env: unknown,
				ctx: ExecutionContext,
			) => Promise<void>;
		};
		expect(worker.scheduled).toBeTypeOf("function");

		const ctx = createExecutionContext();
		await worker.scheduled?.(
			createScheduledController({ scheduledTime: new Date(), cron: "0 18 * * *" }),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		const stored = await listBackups(env as never, mailboxId);
		expect(stored).toHaveLength(1);
	});
});
