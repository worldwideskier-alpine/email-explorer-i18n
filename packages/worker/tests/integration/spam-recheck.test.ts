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

async function deliver(subject: string): Promise<void> {
	const raw = [
		"From: sender@legit.com",
		`To: ${mailboxId}`,
		`Subject: ${subject}`,
		"Content-Type: text/plain",
		`Authentication-Results: ${PASSING_AUTH_RESULTS}`,
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

	it("leaves alone a message its reader has moved, starred or answered, and asks nothing about it", async () => {
		const subjects = {
			moved:
				"Moved TRIGGER_CLAUDE_BLOCKED_LATERMOVED_3 TRIGGER_CLAUDE_COUNT_JUDGED",
			starred:
				"Starred TRIGGER_CLAUDE_BLOCKED_LATERSTARRED_3 TRIGGER_CLAUDE_COUNT_JUDGED",
			answered:
				"Answered TRIGGER_CLAUDE_BLOCKED_LATERANSWERED_3 TRIGGER_CLAUDE_COUNT_JUDGED",
		};
		for (const subject of Object.values(subjects)) await deliver(subject);
		expect(await claudeCalls("JUDGED")).toBe(9);

		await mailbox().moveEmail(await idOf(subjects.moved), "archive");
		await mailbox().updateEmail(await idOf(subjects.starred), {
			starred: true,
		});
		const answered = await idOf(subjects.answered);
		await runInDurableObject(mailbox(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET replied_at = ? WHERE id = ?",
				new Date().toISOString(),
				answered,
			);
		});

		const entries = await schedule().spamRecheckEntries();
		expect(entries).toHaveLength(3);
		const latest = Math.max(...entries.map((e) => e.next_at));
		expect(await schedule().runSpamRechecks(latest)).toMatchObject({
			asked: 3,
			settled: 3,
		});
		expect(await folderOf(subjects.moved)).toBe("archive");
		expect(await folderOf(subjects.starred)).toBe("inbox");
		expect(await folderOf(subjects.answered)).toBe("inbox");
		expect(await claudeCalls("JUDGED")).toBe(9);
		expect(await schedule().spamRecheckEntries()).toEqual([]);
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
		// "Since" keeps the time it was delivered: after the marker.
		await mailbox().updateEmail(await idOf("Kept TRIGGER_CLAUDE_SPAM"), {
			starred: true,
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
});
