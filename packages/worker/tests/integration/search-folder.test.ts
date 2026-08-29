import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Searching with ?folder= was the one branch of searchEmails with no test, and
 * it is the branch that resolves a folder before filtering on it. A folder can
 * be named either way round -- "inbox" is the row's id and "Inbox" its display
 * name -- and both have to work, so the resolution cannot be dropped in favour
 * of comparing folder_id to the string directly.
 */

interface FoundEmail {
	id: string;
	subject: string;
}

function rawEmail(subject: string): string {
	return Buffer.from(
		[
			"From: sender@example.org",
			`To: ${mailboxId}`,
			`Subject: ${subject}`,
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			"needle in the body",
			"",
		].join("\r\n"),
		"utf8",
	).toString("base64");
}

async function importInto(folder: string, subject: string): Promise<void> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder, rawEmailBase64: rawEmail(subject) }),
		},
	);
	expect(res.status).toBe(201);
}

async function search(params: string): Promise<FoundEmail[]> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/search?${params}`,
	);
	expect(res.status).toBe(200);
	return res.json<FoundEmail[]>();
}

async function list(params: string): Promise<FoundEmail[]> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?${params}`,
	);
	expect(res.status).toBe(200);
	return res.json<FoundEmail[]>();
}

const subjects = (found: FoundEmail[]): string[] =>
	found.map((e) => e.subject).sort();

describe("Searching within one folder", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await importInto("inbox", "in-the-inbox");
		await importInto("archive", "in-the-archive");
	});

	it("finds mail in every folder when none is named", async () => {
		expect(subjects(await search("query=needle"))).toEqual([
			"in-the-archive",
			"in-the-inbox",
		]);
	});

	it("filters by the folder's id", async () => {
		expect(subjects(await search("query=needle&folder=inbox"))).toEqual([
			"in-the-inbox",
		]);
		expect(subjects(await search("query=needle&folder=archive"))).toEqual([
			"in-the-archive",
		]);
	});

	// The stored folder_id is "inbox", so this only works if the display name is
	// resolved to an id first.
	it("filters by the folder's display name", async () => {
		expect(subjects(await search("query=needle&folder=Inbox"))).toEqual([
			"in-the-inbox",
		]);
	});

	it("returns nothing for a folder that does not exist", async () => {
		expect(await search("query=needle&folder=nosuchfolder")).toEqual([]);
	});

	it("still applies the text query inside the folder", async () => {
		expect(await search("query=nomatch&folder=inbox")).toEqual([]);
	});
});

/**
 * Listing resolves the folder the same way, and is the path every mailbox view
 * goes through, so it gets the same cases.
 */
describe("Listing one folder", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await importInto("inbox", "in-the-inbox");
		await importInto("archive", "in-the-archive");
	});

	it("filters by the folder's id", async () => {
		expect(subjects(await list("folder=inbox"))).toEqual(["in-the-inbox"]);
		expect(subjects(await list("folder=archive"))).toEqual(["in-the-archive"]);
	});

	it("filters by the folder's display name", async () => {
		expect(subjects(await list("folder=Inbox"))).toEqual(["in-the-inbox"]);
	});

	it("returns nothing for a folder that does not exist", async () => {
		expect(await list("folder=nosuchfolder")).toEqual([]);
	});

	it("lists every folder when none is named", async () => {
		expect(subjects(await list("limit=50"))).toEqual([
			"in-the-archive",
			"in-the-inbox",
		]);
	});
});
