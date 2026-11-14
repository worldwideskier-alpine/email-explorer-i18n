import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	HEADER_BYTES,
	hasReplacement,
	onlyReplacementsTakenOut,
	SUBJECTS_PER_LIST,
} from "../../src/decoding-repair";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A message stored before a fix to how mail is decoded is put right when it
 * is opened (decoding-repair.ts).
 *
 * The case it was made for: a card company's notice, received an hour before
 * ISO-2022-JP stopped being read with a U+FFFD between two JIS runs
 * (patches/postal-mime.patch), kept the character on screen after the fix,
 * because its body had been stored as text at ingest. The words here are
 * made up; the byte pattern is that message's.
 */

const ESC = "\x1b";
// "）" and "を" as two JIS runs, the first closed and the next opened at once.
const SPLIT = `=1B$B!K=1B(B=1B$B$=\r\nr=1B(B`;
// A subject of one encoded word holding the same pattern: "お" twice.
const SPLIT_SUBJECT = btoa(`${ESC}$B$*${ESC}(B${ESC}$B$*${ESC}(B`);

function iso2022jpMessage(body: string, subject = SPLIT_SUBJECT): string {
	return [
		"From: notice@example.com",
		`To: ${mailboxId}`,
		`Subject: =?iso-2022-jp?B?${subject}?=`,
		"MIME-Version: 1.0",
		'Content-Type: text/html; charset="iso-2022-jp"',
		"Content-Transfer-Encoding: quoted-printable",
		"",
		body,
		"",
	].join("\r\n");
}

async function deliver(raw: string): Promise<void> {
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

async function listed(): Promise<{ id: string; subject: string }[]> {
	const list = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
	);
	expect(list.status).toBe(200);
	return list.json<{ id: string; subject: string }[]>();
}

async function receive(raw: string): Promise<string> {
	await deliver(raw);
	const emails = await listed();
	expect(emails).toHaveLength(1);
	return emails[0].id;
}

function mailbox() {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

/** The row as the object holds it, read past every route. */
async function storedRow(id: string) {
	return runInDurableObject(mailbox(), async (_instance, state) => {
		return state.storage.sql
			.exec<{ subject: string | null; body: string | null }>(
				"SELECT subject, body FROM emails WHERE id = ?",
				id,
			)
			.one();
	});
}

/** Puts the row back as a Worker from before the fix stored it. */
async function storeAsBefore(
	id: string,
	row: { subject: string | null; body: string | null },
) {
	await runInDurableObject(mailbox(), async (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE emails SET subject = ?, body = ? WHERE id = ?",
			row.subject,
			row.body,
			id,
		);
	});
}

async function open(id: string) {
	const response = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
	);
	expect(response.status).toBe(200);
	return response.json<{ subject: string; body: string }>();
}

describe("a message stored before a fix to its decoding", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("is put right when opened, and stays right", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		// As it was stored before the fix: a replacement character where the
		// runs meet, in the body and in the subject.
		await storeAsBefore(id, {
			subject: "お�お",
			body: "<td>）�を</td>\n",
		});

		const shown = await open(id);
		expect(shown.subject).toBe("おお");
		expect(shown.body).toBe("<td>）を</td>\n");

		// Written back, so the list and the next open show it too.
		expect(await storedRow(id)).toEqual({
			subject: "おお",
			body: "<td>）を</td>\n",
		});
	});

	it("leaves a replacement character the original itself reads as one", async () => {
		// A stray byte the fix rightly still reads as U+FFFD: reading the
		// original again gives the same text, so nothing is written.
		const raw = iso2022jpMessage(`<td>=1B$B!K=AE=1B(B</td>`);
		const id = await receive(raw);
		const before = await storedRow(id);
		expect(hasReplacement(before.body)).toBe(true);

		const shown = await open(id);
		expect(shown.body).toBe(before.body);
		expect(await storedRow(id)).toEqual(before);
	});

	it("changes nothing when the stored text differs in anything but replacement characters", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		// Text the original does not read as: a rewrite would replace a word.
		const altered = {
			subject: "お�お",
			body: "<td>）�を and more</td>\n",
		};
		await storeAsBefore(id, altered);

		const shown = await open(id);
		expect(shown.body).toBe(altered.body);
		// The subject alone qualifies, and is put right on its own.
		expect(shown.subject).toBe("おお");
		expect((await storedRow(id)).body).toBe(altered.body);
	});

	it("shows the message as stored when its original is gone", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		const garbled = { subject: "お�お", body: "<td>）�を</td>\n" };
		await storeAsBefore(id, garbled);
		await env.BUCKET.delete(`raw/${id}.eml`);

		const shown = await open(id);
		expect(shown.subject).toBe(garbled.subject);
		expect(shown.body).toBe(garbled.body);
	});

	it("writes nothing over a message changed since it was read", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		const garbled = { subject: "お�お", body: "<td>）�を</td>\n" };
		await storeAsBefore(id, garbled);
		// Somebody else's write lands between the read and the repair.
		await storeAsBefore(id, { subject: "changed", body: "changed" });

		const written = await mailbox().repairDecoding(id, garbled, {
			subject: "おお",
			body: "<td>）を</td>\n",
		});
		expect(written).toBe(false);
		expect(await storedRow(id)).toEqual({
			subject: "changed",
			body: "changed",
		});
	});
});

describe("a subject stored before a fix to its decoding, in a list", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	const GARBLED = { subject: "お\uFFFDお", body: "<td>）\uFFFDを</td>\n" };

	it("is put right in the list and written back, the body left for the open", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		await storeAsBefore(id, GARBLED);

		const [row] = await listed();
		expect(row.subject).toBe("おお");
		// The subject is written back; the body waits for the message to be
		// opened, since a list reads only the original's header.
		expect(await storedRow(id)).toEqual({
			subject: "おお",
			body: GARBLED.body,
		});
	});

	it("is put right in search results too", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		await storeAsBefore(id, GARBLED);

		const found = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/search?query=td`,
		);
		expect(found.status).toBe(200);
		const [row] = await found.json<{ id: string; subject: string }[]>();
		expect(row.subject).toBe("おお");
		expect((await storedRow(id)).subject).toBe("おお");
	});

	it(`reads no more than ${SUBJECTS_PER_LIST} originals for one answer`, async () => {
		const count = SUBJECTS_PER_LIST + 2;
		for (let i = 0; i < count; i++) {
			await deliver(iso2022jpMessage(`<td>${SPLIT}</td>`));
		}
		const ids = (await listed()).map((row) => row.id);
		expect(ids).toHaveLength(count);
		for (const id of ids) await storeAsBefore(id, GARBLED);

		const fixedAfter = async () =>
			(await Promise.all(ids.map(storedRow))).filter(
				(row) => row.subject === "おお",
			).length;

		await listed();
		expect(await fixedAfter()).toBe(SUBJECTS_PER_LIST);
		// Those put right are not read again, so the next answer reaches the rest.
		await listed();
		expect(await fixedAfter()).toBe(count);
	}, 30_000);

	it("leaves a subject whose replacement character is the sender's own", async () => {
		// A stray byte the fix rightly still reads as U+FFFD.
		await deliver(
			iso2022jpMessage(`<td>${SPLIT}</td>`, btoa(`${ESC}$B$*\xae${ESC}(B`)),
		);
		const [before] = await listed();
		expect(hasReplacement(before.subject)).toBe(true);
		const [after] = await listed();
		expect(after.subject).toBe(before.subject);
		expect((await storedRow(after.id)).subject).toBe(before.subject);
	});

	it("changes nothing when the stored subject differs in more than replacement characters", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		const altered = { subject: "お\uFFFDお and more", body: GARBLED.body };
		await storeAsBefore(id, altered);

		const [row] = await listed();
		expect(row.subject).toBe(altered.subject);
		expect((await storedRow(id)).subject).toBe(altered.subject);
	});

	it("writes nothing over a subject changed since the list read it", async () => {
		const id = await receive(iso2022jpMessage(`<td>${SPLIT}</td>`));
		await storeAsBefore(id, { subject: "changed", body: GARBLED.body });

		expect(await mailbox().repairSubject(id, GARBLED.subject, "おお")).toBe(
			false,
		);
		expect((await storedRow(id)).subject).toBe("changed");
	});

	it("leaves a subject whose original's header runs past what is read, and still answers", async () => {
		// The header block is longer than the range read, and the subject
		// comes after the padding.
		const raw = iso2022jpMessage(`<td>${SPLIT}</td>`).replace(
			"From: notice@example.com\r\n",
			`From: notice@example.com\r\nX-Padding: ${"a".repeat(HEADER_BYTES)}\r\n`,
		);
		const id = await receive(raw);
		await storeAsBefore(id, GARBLED);

		const [row] = await listed();
		expect(row.subject).toBe(GARBLED.subject);
		// Opening it reads the whole original and puts both right.
		expect((await open(id)).subject).toBe("おお");
	});
});

describe("onlyReplacementsTakenOut", () => {
	it("is true only when replacement characters, and nothing else, are gone", () => {
		expect(onlyReplacementsTakenOut("）�を", "）を")).toBe(true);
		expect(onlyReplacementsTakenOut("��a�", "a")).toBe(true);
		expect(onlyReplacementsTakenOut("a��b", "a�b")).toBe(true);

		// Nothing taken out.
		expect(onlyReplacementsTakenOut("a�b", "a�b")).toBe(false);
		// A replacement character that moved.
		expect(onlyReplacementsTakenOut("a��b", "ab�")).toBe(false);
		// Anything else that changed, was added or went.
		expect(onlyReplacementsTakenOut("a�b", "ac")).toBe(false);
		expect(onlyReplacementsTakenOut("a�bc", "ab")).toBe(false);
		expect(onlyReplacementsTakenOut("a�b", "xab")).toBe(false);
		expect(onlyReplacementsTakenOut("�", "")).toBe(true);
	});
});
