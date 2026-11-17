import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	GIVE_UP_AFTER_MS,
	RECENT_MS,
	RECHECK_DELAYS_MS,
	RECHECK_OBJECT,
} from "../../src/spam-recheck";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A second-stage check that got no answer is asked again later
 * (spam-recheck.ts).
 *
 * The check fails open, and it used to be asked once: on 2026-11-17 the live
 * mailbox's check was refused by Cloudflare in front of the API at 17:10,
 * three attempts in twenty seconds, after classifying at 16:04 -- and a
 * phishing message the day before had reached the inbox with nothing to say
 * whether it was ever judged. The stub refuses the first n attempts against a
 * tag and then answers (vitest.config.mts), so the answer arriving at all is
 * proof the recheck asked; each test uses a tag of its own, since the count
 * lives as long as the worker process.
 */

const PASSING_AUTH_RESULTS =
	"mx.cloudflare.net; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";

async function deliver(
	subject: string,
	{
		from = "sender@legit.com",
		auth = PASSING_AUTH_RESULTS,
	}: { from?: string; auth?: string } = {},
): Promise<void> {
	const raw = [
		`From: ${from}`,
		`To: ${mailboxId}`,
		`Subject: ${subject}`,
		"Content-Type: text/plain",
		`Authentication-Results: ${auth}`,
		"",
		"Hello",
		"",
	].join("\r\n");
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(raw);
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			rawSize: bytes.length,
			to: mailboxId,
		},
		env,
		createExecutionContext(),
	);
}

async function giveKey(): Promise<void> {
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			settings: { spamFilter: { claudeApiKey: "sk-ant-test-key" } },
		}),
	});
}

async function listed(
	folder: string,
): Promise<{ id: string; subject: string }[]> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
	);
	return res.json();
}

/**
 * Read from the object rather than the list route: reading a list offers the
 * mailbox's recent inbox to the schedule, which only the test about that
 * should do.
 */
async function idOf(subject: string): Promise<string> {
	return runInDurableObject(mailbox(), async (_instance, state) => {
		const [row] = state.storage.sql
			.exec<{ id: string }>("SELECT id FROM emails WHERE subject = ?", subject)
			.toArray();
		if (!row) throw new Error(`no message "${subject}"`);
		return row.id;
	});
}

/** Read from the object, so a list cannot start a recheck of its own. */
async function folderOf(subject: string): Promise<string | undefined> {
	return runInDurableObject(mailbox(), async (_instance, state) => {
		const [row] = state.storage.sql
			.exec<{ folder_id: string }>(
				"SELECT folder_id FROM emails WHERE subject = ?",
				subject,
			)
			.toArray();
		return row?.folder_id;
	});
}

function mailbox() {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

function schedule() {
	return env.MAILBOX.get(env.MAILBOX.idFromName(RECHECK_OBJECT));
}

async function claudeCalls(tag: string): Promise<number> {
	return (await fetch(`https://api.anthropic.com/__calls/${tag}`)).json();
}

describe("a check that got no answer", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await giveKey();
	});

	it("is asked again later, and a SPAM answer files the message as spam", async () => {
		// Three refusals spend delivery's three attempts; the fourth answers.
		const subject = "Phish TRIGGER_CLAUDE_BLOCKED_LATERSPAM_3";
		await deliver(subject);
		expect(await folderOf(subject)).toBe("inbox");

		const [entry] = await schedule().spamRecheckEntries();
		expect(entry).toMatchObject({
			mailbox_id: mailboxId,
			email_id: await idOf(subject),
			attempts: 1,
			last_failure: "blocked",
			gave_up_at: null,
		});
		expect(entry.next_at - entry.first_at).toBe(RECHECK_DELAYS_MS[0]);

		// Not before its time.
		expect((await schedule().runSpamRechecks(entry.first_at)).asked).toBe(0);
		expect(await folderOf(subject)).toBe("inbox");

		expect(await schedule().runSpamRechecks(entry.next_at)).toMatchObject({
			asked: 1,
			settled: 1,
		});
		expect(await folderOf(subject)).toBe("spam");
		expect(await schedule().spamRecheckEntries()).toEqual([]);
	});

	it("leaves the message where it is when the answer is not spam", async () => {
		const subject =
			"Fine TRIGGER_CLAUDE_BLOCKED_LATERHAM_3 TRIGGER_CLAUDE_THEN_HAM";
		await deliver(subject);
		const [entry] = await schedule().spamRecheckEntries();

		await schedule().runSpamRechecks(entry.next_at);
		expect(await folderOf(subject)).toBe("inbox");
		expect(await schedule().spamRecheckEntries()).toEqual([]);
	});

	it("takes back the notification a message it files as spam was announced with", async () => {
		const subject = "Announced TRIGGER_CLAUDE_BLOCKED_LATERNOTE_3";
		await deliver(subject);
		const id = await idOf(subject);
		// No device is subscribed here, so delivery's mark was taken back;
		// put it as a device that took the notification would have left it.
		await mailbox().markNotified(id);
		const [entry] = await schedule().spamRecheckEntries();

		await schedule().runSpamRechecks(entry.next_at);
		expect(await folderOf(subject)).toBe("spam");
		const notified = await runInDurableObject(
			mailbox(),
			async (_i, state) =>
				state.storage.sql
					.exec<{ notified: number }>(
						"SELECT notified FROM emails WHERE id = ?",
						id,
					)
					.one().notified,
		);
		expect(notified).toBe(0);
	});

	it("leaves alone a message its reader has moved, starred, answered or forwarded, and asks nothing about it", async () => {
		const subjects = {
			moved:
				"Moved TRIGGER_CLAUDE_BLOCKED_LATERMOVED_3 TRIGGER_CLAUDE_COUNT_JUDGED",
			starred:
				"Starred TRIGGER_CLAUDE_BLOCKED_LATERSTARRED_3 TRIGGER_CLAUDE_COUNT_JUDGED",
			answered:
				"Answered TRIGGER_CLAUDE_BLOCKED_LATERANSWERED_3 TRIGGER_CLAUDE_COUNT_JUDGED",
			forwarded:
				"Forwarded TRIGGER_CLAUDE_BLOCKED_LATERFORWARDED_3 TRIGGER_CLAUDE_COUNT_JUDGED",
		};
		for (const subject of Object.values(subjects)) await deliver(subject);
		expect(await claudeCalls("JUDGED")).toBe(12);

		await mailbox().moveEmail(await idOf(subjects.moved), "archive");
		await mailbox().updateEmail(await idOf(subjects.starred), {
			starred: true,
		});
		const answered = await idOf(subjects.answered);
		const forwarded = await idOf(subjects.forwarded);
		await runInDurableObject(mailbox(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET replied_at = ? WHERE id = ?",
				new Date().toISOString(),
				answered,
			);
			state.storage.sql.exec(
				"UPDATE emails SET forwarded_at = ? WHERE id = ?",
				new Date().toISOString(),
				forwarded,
			);
		});

		const entries = await schedule().spamRecheckEntries();
		expect(entries).toHaveLength(4);
		const latest = Math.max(...entries.map((e) => e.next_at));
		expect(await schedule().runSpamRechecks(latest)).toMatchObject({
			asked: 4,
			settled: 4,
		});
		expect(await folderOf(subjects.moved)).toBe("archive");
		expect(await folderOf(subjects.starred)).toBe("inbox");
		expect(await folderOf(subjects.answered)).toBe("inbox");
		expect(await folderOf(subjects.forwarded)).toBe("inbox");
		expect(await claudeCalls("JUDGED")).toBe(12);
		expect(await schedule().spamRecheckEntries()).toEqual([]);
	});

	it("leaves alone a message its reader stars while the check is being asked", async () => {
		// Delivery spends three refusals; the recheck's first attempt is the
		// fourth, and the classifier waits half a second before the fifth,
		// which answers SPAM. The star goes in during that wait, after the
		// recheck has read the message as nobody's yet.
		const subject =
			"Racing TRIGGER_CLAUDE_BLOCKED_LATERRACE_4 TRIGGER_CLAUDE_COUNT_RACE";
		await deliver(subject);
		expect(await claudeCalls("RACE")).toBe(3);
		const [entry] = await schedule().spamRecheckEntries();

		const run = schedule().runSpamRechecks(entry.next_at);
		for (
			let tries = 0;
			tries < 400 && (await claudeCalls("RACE")) < 4;
			tries++
		) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(await claudeCalls("RACE")).toBe(4);
		await mailbox().updateEmail(await idOf(subject), { starred: true });
		await run;

		expect(await claudeCalls("RACE")).toBe(5);
		expect(await folderOf(subject)).toBe("inbox");
		expect(await schedule().spamRecheckEntries()).toEqual([]);
	});

	it("asks again about mail from the mailbox's own address that delivery asked about", async () => {
		// A From of the mailbox's own address is anybody's to write. Delivery
		// asks about it unless DMARC passed for that domain, and so does the
		// recheck: a skip of its own here left exactly this forgery unjudged.
		const subject = "Own address TRIGGER_CLAUDE_BLOCKED_LATEROWN_3";
		await deliver(subject, {
			from: mailboxId,
			auth: "mx.cloudflare.net; spf=pass smtp.mailfrom=elsewhere.test; dkim=none; dmarc=none header.from=example.com",
		});
		const [entry] = await schedule().spamRecheckEntries();
		expect(entry).toMatchObject({ email_id: await idOf(subject) });

		await schedule().runSpamRechecks(entry.next_at);
		expect(await folderOf(subject)).toBe("spam");
	});

	it("gives up without asking an entry already older than the day, as one left by a rollback would be", async () => {
		const subject =
			"Stale TRIGGER_CLAUDE_BLOCKED_LATERSTALE_3 TRIGGER_CLAUDE_COUNT_STALE";
		await deliver(subject);
		const [entry] = await schedule().spamRecheckEntries();
		// As if code from before this had held the alarm for three days.
		const firstAt = entry.next_at - 3 * GIVE_UP_AFTER_MS;
		await runInDurableObject(schedule(), async (_i, state) => {
			state.storage.sql.exec("UPDATE spam_rechecks SET first_at = ?", firstAt);
		});

		expect(await schedule().runSpamRechecks(entry.next_at)).toMatchObject({
			asked: 0,
		});
		expect(await claudeCalls("STALE")).toBe(3);
		expect(await folderOf(subject)).toBe("inbox");
		const [after] = await schedule().spamRecheckEntries();
		expect(after.gave_up_at).not.toBeNull();
	});

	// Every recheck here is refused three times with the classifier's own
	// waits between attempts, real seconds each, a dozen times over: the
	// budget is that waiting, not slowness.
	it("asks on a widening schedule, and gives up a day after the first refusal", {
		timeout: 90_000,
	}, async () => {
		const subject =
			"Never TRIGGER_CLAUDE_BLOCKED_LATERNEVER_9999 TRIGGER_CLAUDE_COUNT_NEVER";
		await deliver(subject);
		let [entry] = await schedule().spamRecheckEntries();
		const firstAt = entry.first_at;
		const gaps: number[] = [entry.next_at - firstAt];

		for (let run = 0; run < 40 && entry.gave_up_at === null; run++) {
			const at = entry.next_at;
			await schedule().runSpamRechecks(at);
			[entry] = await schedule().spamRecheckEntries();
			if (entry.gave_up_at === null) gaps.push(entry.next_at - at);
		}

		expect(entry.gave_up_at).not.toBeNull();
		expect(entry.gave_up_at - firstAt).toBeLessThanOrEqual(GIVE_UP_AFTER_MS);
		const longest = RECHECK_DELAYS_MS[RECHECK_DELAYS_MS.length - 1];
		expect(gaps.slice(0, RECHECK_DELAYS_MS.length)).toEqual(RECHECK_DELAYS_MS);
		for (const gap of gaps.slice(RECHECK_DELAYS_MS.length)) {
			expect(gap).toBe(longest);
		}
		expect(await folderOf(subject)).toBe("inbox");

		// Given up is given up: nothing more is asked.
		const asked = await claudeCalls("NEVER");
		expect(
			(await schedule().runSpamRechecks(firstAt + 2 * GIVE_UP_AFTER_MS)).asked,
		).toBe(0);
		expect(await claudeCalls("NEVER")).toBe(asked);
	});

	it("does not write down a refusal that asking again would not change", async () => {
		await deliver("Bad key TRIGGER_CLAUDE_401");
		await deliver("Unreadable TRIGGER_CLAUDE_PREAMBLE");
		expect(await schedule().spamRecheckEntries()).toEqual([]);
	});

	it("keeps its schedule apart from the mailbox's night", async () => {
		await deliver("Apart TRIGGER_CLAUDE_BLOCKED_LATERAPART_3");
		const mailboxAlarm = await runInDurableObject(mailbox(), (_i, state) =>
			state.storage.getAlarm(),
		);
		const scheduleAlarm = await runInDurableObject(schedule(), (_i, state) =>
			state.storage.getAlarm(),
		);
		expect(mailboxAlarm).toBeNull();
		expect(scheduleAlarm).not.toBeNull();
		// And the schedule's object stores no night for an alarm to run.
		const night = await runInDurableObject(schedule(), (_i, state) =>
			state.storage.get("night"),
		);
		expect(night).toBeUndefined();
	});
});

describe("the last week of a mailbox's inbox", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is offered once, on the first list, and judged as the schedule's alarm comes", async () => {
		// Delivered with no key, so never judged, and dated before this
		// mailbox's object first wrote unanswered checks down: what a message
		// whose check met a refusal before this change looks like. Then the
		// key is set.
		await deliver("Recent TRIGGER_CLAUDE_SPAM");
		await deliver("Older TRIGGER_CLAUDE_SPAM");
		await deliver("Kept TRIGGER_CLAUDE_SPAM");
		await deliver("Since TRIGGER_CLAUDE_SPAM");
		await deliver("Opened TRIGGER_CLAUDE_SPAM");
		await deliver("Restored TRIGGER_CLAUDE_SPAM");
		const receivedAt = async (subject: string, at: number) => {
			const id = await idOf(subject);
			await runInDurableObject(mailbox(), async (_i, state) => {
				state.storage.sql.exec(
					"UPDATE emails SET received_at = ? WHERE id = ?",
					new Date(at).toISOString(),
					id,
				);
			});
		};
		const since = await runInDurableObject(mailbox(), async (_i, state) =>
			Date.parse(
				state.storage.sql
					.exec<{ at: string }>("SELECT at FROM spam_recheck_since")
					.one().at,
			),
		);
		await receivedAt("Recent TRIGGER_CLAUDE_SPAM", since - 60_000);
		await receivedAt("Kept TRIGGER_CLAUDE_SPAM", since - 60_000);
		await receivedAt(
			"Older TRIGGER_CLAUDE_SPAM",
			Date.now() - RECENT_MS - 60_000,
		);
		await receivedAt("Opened TRIGGER_CLAUDE_SPAM", since - 60_000);
		await receivedAt("Restored TRIGGER_CLAUDE_SPAM", since - 60_000);
		// "Since" keeps the time it was delivered: after the marker.
		await mailbox().updateEmail(await idOf("Kept TRIGGER_CLAUDE_SPAM"), {
			starred: true,
		});
		// Opened: what a message its reader took out of spam looks like, which
		// a second judgment would only file again.
		await mailbox().updateEmail(await idOf("Opened TRIGGER_CLAUDE_SPAM"), {
			read: true,
		});
		// Restored from an archive this week: it carries its own date, years
		// back, and no check of this deployment's ever met it.
		const restored = await idOf("Restored TRIGGER_CLAUDE_SPAM");
		await runInDurableObject(mailbox(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET date = ? WHERE id = ?",
				"2019-04-01T09:00:00.000Z",
				restored,
			);
		});
		await giveKey();

		// The list offers it, behind its answer, to be asked about at once;
		// the schedule's own alarm does the asking, with nobody calling it.
		await listed("inbox");
		for (
			let tries = 0;
			tries < 200 && (await folderOf("Recent TRIGGER_CLAUDE_SPAM")) !== "spam";
			tries++
		) {
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(await folderOf("Recent TRIGGER_CLAUDE_SPAM")).toBe("spam");
		expect(await folderOf("Older TRIGGER_CLAUDE_SPAM")).toBe("inbox");
		expect(await folderOf("Kept TRIGGER_CLAUDE_SPAM")).toBe("inbox");
		// Delivered since: anything unanswered of it would be on the schedule
		// already, so the pass does not ask about it again.
		expect(await folderOf("Since TRIGGER_CLAUDE_SPAM")).toBe("inbox");
		expect(await folderOf("Opened TRIGGER_CLAUDE_SPAM")).toBe("inbox");
		expect(await folderOf("Restored TRIGGER_CLAUDE_SPAM")).toBe("inbox");
		expect(await schedule().spamRecheckEntries()).toEqual([]);

		// Once. Its reader takes it back out of spam, as somebody who knows
		// the sender would; a second pass would only file it again.
		await mailbox().moveEmail(
			await idOf("Recent TRIGGER_CLAUDE_SPAM"),
			"inbox",
		);
		expect(await mailbox().offerRecentForRecheck(mailboxId)).toBe(0);
		expect(await schedule().spamRecheckEntries()).toEqual([]);
	});

	it("is not offered for a mailbox with no key, where nothing was ever asked", async () => {
		await deliver("Keyless TRIGGER_CLAUDE_SPAM TRIGGER_CLAUDE_COUNT_KEYLESS");
		const id = await idOf(
			"Keyless TRIGGER_CLAUDE_SPAM TRIGGER_CLAUDE_COUNT_KEYLESS",
		);
		await runInDurableObject(mailbox(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET received_at = ? WHERE id = ?",
				new Date(Date.now() - 60 * 60_000).toISOString(),
				id,
			);
		});

		expect(await mailbox().offerRecentForRecheck(mailboxId)).toBe(0);
		expect(await schedule().spamRecheckEntries()).toEqual([]);
		expect(await claudeCalls("KEYLESS")).toBe(0);
	});
});
