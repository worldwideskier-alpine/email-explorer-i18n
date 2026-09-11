import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The bucket, checked against the mail that claims it.
 *
 * An attachment object is reachable only through its row: every reader --
 * download, archive, delete -- rebuilds `attachments/{emailId}/{attachmentId}/
 * {filename}` from what the row says. So an object the rows do not name is
 * reachable from nothing, and the two ways that has happened are the two
 * things this sweep has to tell apart.
 *
 * A **misnamed** object still belongs to a message somebody can open: ingestion
 * once wrote the key from the raw parsed filename while the row recorded
 * `filename || "untitled"`, so an unnamed attachment went to `.../null` and was
 * looked for at `.../untitled`. Deleting those would destroy the only copy of
 * somebody's attachment. They are moved.
 *
 * An **unclaimed** object is what a deletion that stopped halfway leaves --
 * the spam purge deletes the row first on purpose, so the failure mode is
 * objects nothing points at rather than a message that opens to nothing. Those
 * can go, and only when asked for separately, because the same description
 * also fits a mailbox that was deleted without `purge` and is meant to come
 * back.
 */

const PASSING_AUTH =
	"mx.test; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";

const raw = (to: string, filename: string) =>
	[
		"From: sender@legit.com",
		`To: ${to}`,
		"Subject: with an attachment",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"see attached",
		"--b",
		"Content-Type: application/octet-stream",
		`Content-Disposition: attachment; filename="${filename}"`,
		"Content-Transfer-Encoding: base64",
		"",
		btoa("the bytes"),
		"--b--",
	].join("\r\n");

async function receive(message: string, to: string) {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(message);
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			rawSize: bytes.length,
			to,
			headers: new Headers({ "Authentication-Results": PASSING_AUTH }),
			setReject: () => {},
		} as never,
		env,
		createExecutionContext(),
	);
}

/** The one attachment of the one message, as the mailbox reports it. */
async function theAttachment() {
	const list = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox&limit=10`,
	);
	const emails = await list.json<{ id: string }[]>();
	const one = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emails[0]?.id}`,
	);
	const message = await one.json<{
		id: string;
		attachments?: { id: string; filename: string }[];
	}>();
	const attachment = message.attachments?.[0];
	if (!attachment) throw new Error("the fixture message has no attachment");
	return {
		emailId: message.id,
		attachmentId: attachment.id,
		filename: attachment.filename,
		key: `attachments/${message.id}/${attachment.id}/${attachment.filename}`,
	};
}

/** Puts the object back under the name the old ingest would have used. */
async function renameToOldBug(key: string) {
	const stored = await env.BUCKET.get(key);
	if (!stored) throw new Error(`nothing at ${key}`);
	const wrong = `${key.slice(0, key.lastIndexOf("/"))}/null`;
	await env.BUCKET.put(wrong, await stored.arrayBuffer());
	await env.BUCKET.delete(key);
	return wrong;
}

async function register(email: string, password: string) {
	return SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
}

async function signIn(email: string, password = "password123") {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return res.json<{ id: string; role?: string }>();
}

function as(token: string) {
	return (url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});
}

interface Sweep {
	objects: number;
	matched: number;
	misnamed: number;
	unclaimed: number;
	unreadable: number;
	unclaimedBytes: number;
}

describe("the attachment sweep", () => {
	let root: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();
		// The fixture login in utils is what createDummyMailbox and the mailbox
		// routes use; root is a separate account, because the sweep is root's.
		await register("operator@example.com", "password123");
		root = (await signIn("operator@example.com")).id;
		// Root first: registration closes behind the first account, and the
		// fixture login is written straight into the auth object rather than
		// registered, so doing it the other way round locks root out.
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	const survey = async () =>
		(await as(root)("http://local.test/api/v1/root/attachments")).json<Sweep>();

	const repair = async () =>
		(
			await as(root)("http://local.test/api/v1/root/attachments/repair", {
				method: "POST",
			})
		).json<{ repaired: number; duplicates: number; remaining: number }>();

	const purge = async () =>
		(
			await as(root)("http://local.test/api/v1/root/attachments/purge", {
				method: "POST",
			})
		).json<{ deleted: number; bytes: number; remaining: number }>();

	it("says nothing is wrong when nothing is", async () => {
		await receive(raw(mailboxId, "report.pdf"), mailboxId);
		const sweep = await survey();
		expect(sweep.objects).toBe(1);
		expect(sweep.matched).toBe(1);
		expect(sweep.misnamed).toBe(0);
		expect(sweep.unclaimed).toBe(0);
		expect(sweep.unreadable).toBe(0);
	});

	/**
	 * The whole of the old defect, and the whole of the repair: the object is
	 * where it was written, the row says somewhere else, and the download --
	 * which is what a person actually notices -- answers 404 until it is moved.
	 */
	it("moves an object filed under the old name, and the download works again", async () => {
		await receive(raw(mailboxId, "report.pdf"), mailboxId);
		const attachment = await theAttachment();
		const wrong = await renameToOldBug(attachment.key);

		const download = `http://local.test/api/v1/mailboxes/${mailboxId}/emails/${attachment.emailId}/attachments/${attachment.attachmentId}`;
		expect((await authenticatedFetch(download)).status).toBe(404);
		expect((await survey()).misnamed).toBe(1);

		expect(await repair()).toEqual({
			repaired: 1,
			duplicates: 0,
			remaining: 0,
		});

		expect((await authenticatedFetch(download)).status).toBe(200);
		expect(await env.BUCKET.head(attachment.key)).toBeTruthy();
		expect(await env.BUCKET.head(wrong)).toBeNull();
		const after = await survey();
		expect(after.matched).toBe(1);
		expect(after.misnamed).toBe(0);
		expect(after.unclaimed).toBe(0);
	});

	it("leaves the object alone when the row's name is already taken", async () => {
		await receive(raw(mailboxId, "report.pdf"), mailboxId);
		const attachment = await theAttachment();
		// Both names present: the row is reachable, so there is nothing to
		// repair and the old copy is not this step's to delete.
		const wrong = `attachments/${attachment.emailId}/${attachment.attachmentId}/null`;
		await env.BUCKET.put(wrong, "the bytes");

		expect(await repair()).toEqual({
			repaired: 0,
			duplicates: 1,
			remaining: 0,
		});
		expect(await env.BUCKET.head(wrong)).toBeTruthy();
		expect(await env.BUCKET.head(attachment.key)).toBeTruthy();
	});

	it("reads an object no message claims as unclaimed, and the repair does not touch it", async () => {
		await receive(raw(mailboxId, "report.pdf"), mailboxId);
		await env.BUCKET.put("attachments/gone/att-1/left-behind.pdf", "orphan");

		const sweep = await survey();
		expect(sweep.objects).toBe(2);
		expect(sweep.matched).toBe(1);
		expect(sweep.unclaimed).toBe(1);
		expect(sweep.unclaimedBytes).toBe(6);

		expect((await repair()).repaired).toBe(0);
		expect(
			await env.BUCKET.head("attachments/gone/att-1/left-behind.pdf"),
		).toBeTruthy();
	});

	/**
	 * The destructive step, held to the one state it is for. A purge that also
	 * took the misnamed object would delete an attachment of a message that is
	 * open on somebody's screen.
	 */
	it("deletes only what nothing claims", async () => {
		await receive(raw(mailboxId, "report.pdf"), mailboxId);
		const attachment = await theAttachment();
		const wrong = await renameToOldBug(attachment.key);
		await env.BUCKET.put("attachments/gone/att-1/left-behind.pdf", "orphan");

		expect(await purge()).toEqual({ deleted: 1, bytes: 6, remaining: 0 });

		expect(
			await env.BUCKET.head("attachments/gone/att-1/left-behind.pdf"),
		).toBeNull();
		expect(await env.BUCKET.head(wrong)).toBeTruthy();
		expect((await survey()).misnamed).toBe(1);
	});

	// The raw copies are named `raw/{emailId}.eml` and are nothing to do with
	// this prefix; a sweep that walked the whole bucket would call every one of
	// them unreadable and invite somebody to delete the lot.
	it("looks at attachments and nothing else in the bucket", async () => {
		await receive(raw(mailboxId, "report.pdf"), mailboxId);
		const sweep = await survey();
		expect(sweep.objects).toBe(1);
		expect(sweep.unreadable).toBe(0);
	});
});

describe("who may sweep", () => {
	beforeEach(async () => {
		resetLegacyGrantMemo();
		await register("operator@example.com", "password123");
	});

	const routes = [
		["GET", "http://local.test/api/v1/root/attachments"],
		["POST", "http://local.test/api/v1/root/attachments/repair"],
		["POST", "http://local.test/api/v1/root/attachments/purge"],
	] as const;

	it("refuses nobody at all", async () => {
		for (const [method, url] of routes) {
			expect((await SELF.fetch(url, { method })).status, url).toBe(401);
		}
	});

	it("refuses an administrator who is not root", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await stub.register("other@example.com", "password123", true);
		const session = await signIn("other@example.com");
		for (const [method, url] of routes) {
			expect((await as(session.id)(url, { method })).status, url).toBe(403);
		}
	});
});
