import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledMaintenance } from "../../src/scheduled-run";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The order of the two scheduled jobs, which is the whole reason the spam
 * purge is allowed to delete permanently.
 *
 * The backup writes the mailbox out, and the purge then deletes the old spam.
 * Reversed, a message would be deleted and the archive taken minutes later
 * would be the first one without it: a permanent deletion with no copy
 * anywhere, offered behind a checkbox.
 *
 * Nothing in the type system holds that ordering -- both are just calls in a
 * function -- so it is asserted here, against the observable consequence
 * rather than against the call order: the deleted message has to be inside
 * the archive that run produced.
 */

const NOW = new Date("2026-09-01T18:00:00.000Z");

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
}

describe("the daily maintenance pass", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("backs the message up before deleting it", async () => {
		await place("Doomed spam", "spam", "2026-07-01T00:00:00.000Z");
		await authenticatedFetch(
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

		const summary = await runScheduledMaintenance(env as never, NOW);
		expect(summary.backups?.ran).toBe(1);
		expect(summary.spamPurge?.deleted).toBe(1);

		// Gone from the mailbox...
		const remaining = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=spam`,
		);
		expect(await remaining.json<{ subject: string }[]>()).toEqual([]);

		// ...and in the archive this same run wrote, which is the property
		// that makes the deletion recoverable.
		const listed = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/backups`,
		);
		const backups = await listed.json<{ name: string }[]>();
		expect(backups.length).toBe(1);

		const archive = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/backups/${encodeURIComponent(
				backups[0]?.name ?? "",
			)}`,
		);
		expect(await archive.text()).toContain("Doomed spam");
	});

	/**
	 * A mailbox whose backup failed must not stop the purge for every mailbox
	 * behind it in the loop -- and the backup pass records its own failure, so
	 * the failure is not lost by carrying on.
	 */
	it("still purges when the backup pass throws", async () => {
		await place("Old spam", "spam", "2026-07-01T00:00:00.000Z");
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: { spamRetention: { enabled: true, days: 30 } },
				}),
			},
		);

		// Both passes begin by listing the mailboxes, so failing only the
		// first list is exactly "the backup pass broke and the purge pass did
		// not".
		let listCalls = 0;
		const broken = {
			...(env as unknown as Record<string, unknown>),
			BUCKET: new Proxy((env as unknown as { BUCKET: R2Bucket }).BUCKET, {
				get(target, prop) {
					if (prop === "list" && listCalls++ === 0) {
						throw new Error("bucket unavailable");
					}
					// Bound to the real bucket: an R2 method called with the
					// proxy as `this` throws "Illegal invocation".
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};

		const summary = await runScheduledMaintenance(broken as never, NOW);
		expect(summary.backupError).toContain("bucket unavailable");
		expect(summary.spamPurge?.deleted).toBe(1);
	});
});
