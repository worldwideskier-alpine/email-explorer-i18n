import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

const settingsKey = (id: string) => `mailboxes/${id}.json`;

async function readSettings(id: string): Promise<any> {
	// @ts-expect-error test binding
	const obj = await env.BUCKET.get(settingsKey(id));
	return obj ? await obj.json() : null;
}

async function setLock(id: string, locked: boolean) {
	const res = await authenticatedFetch(`http://local.test/api/v1/mailboxes/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ settings: { deletionLocked: locked } }),
	});
	expect(res.status).toBe(200);
}

async function importEmail(id: string, subject: string) {
	const raw = [
		"From: sender@example.org",
		`To: ${id}`,
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="BB"',
		"",
		"--BB",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"body",
		"",
		"--BB",
		'Content-Type: text/plain; name="note.txt"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="note.txt"',
		"",
		btoa("attachment payload"),
		"",
		"--BB--",
		"",
	].join("\r\n");

	const res = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${id}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				folder: "inbox",
				rawEmailBase64: btoa(raw),
			}),
		},
	);
	expect(res.status).toBe(201);
	return (await res.json<any>()).id as string;
}

async function countKeys(prefix: string): Promise<number> {
	// @ts-expect-error test binding
	const listed = await env.BUCKET.list({ prefix });
	return listed.objects.length;
}

describe("Mailbox deletion lock", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	// The protection has to hold for a mailbox saved before the setting
	// existed, otherwise every mailbox in an upgraded deployment starts out
	// unprotected -- exactly the case the lock is meant to cover.
	it("treats a mailbox with no explicit setting as locked", async () => {
		// Written straight to the bucket rather than through the create
		// endpoint, which stamps deletionLocked on every new mailbox. The
		// shape under test is the one already sitting in R2 from before the
		// setting existed.
		await createMailbox({ fromName: "Test User" });
		const settings = await readSettings(mailboxId);
		expect(settings.deletionLocked).toBeUndefined();

		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(423);
		expect(await readSettings(mailboxId)).not.toBeNull();
	});

	it("refuses a purge just as firmly as a plain delete", async () => {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}?purge=true`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(423);
		expect(await readSettings(mailboxId)).not.toBeNull();
	});

	it("deletes once the lock is explicitly released", async () => {
		await setLock(mailboxId, false);

		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(204);
		expect(await readSettings(mailboxId)).toBeNull();
	});

	it("keeps the lock through a save that doesn't mention it", async () => {
		await setLock(mailboxId, false);

		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: { signature: { enabled: true, text: "bye" } },
			}),
		});
		expect((await readSettings(mailboxId)).deletionLocked).toBe(false);

		await setLock(mailboxId, true);
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: { signature: { enabled: false, text: "" } },
			}),
		});
		expect((await readSettings(mailboxId)).deletionLocked).toBe(true);
	});

	it("locks a newly created mailbox by default", async () => {
		const created = "fresh@example.com";
		const res = await authenticatedFetch("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: created, name: "Fresh" }),
		});
		expect(res.status).toBe(201);
		expect((await readSettings(created)).deletionLocked).toBe(true);

		const del = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${created}`,
			{ method: "DELETE" },
		);
		expect(del.status).toBe(423);
	});
});

describe("Mailbox deletion: what survives", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("leaves the stored mail intact on a plain delete", async () => {
		const emailId = await importEmail(mailboxId, "kept");
		await setLock(mailboxId, false);

		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(204);

		expect(await countKeys(`raw/${emailId}.eml`)).toBe(1);
		expect(await countKeys(`attachments/${emailId}/`)).toBe(1);

		// @ts-expect-error test binding
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		expect(await stub.listAllEmailIds()).toContain(emailId);
	});

	it("erases mail, attachments and the database on a purge", async () => {
		const emailId = await importEmail(mailboxId, "purged");
		expect(await countKeys(`raw/${emailId}.eml`)).toBe(1);
		expect(await countKeys(`attachments/${emailId}/`)).toBe(1);

		await setLock(mailboxId, false);
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}?purge=true`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(204);

		expect(await readSettings(mailboxId)).toBeNull();
		expect(await countKeys(`raw/${emailId}.eml`)).toBe(0);
		expect(await countKeys(`attachments/${emailId}/`)).toBe(0);

		// @ts-expect-error test binding
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		expect(await stub.listAllEmailIds()).toEqual([]);
	});

	it("purges only its own mailbox's objects", async () => {
		const other = "bystander@example.com";
		await authenticatedFetch("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: other, name: "Bystander" }),
		});
		const otherEmailId = await importEmail(other, "not mine to delete");
		const doomedEmailId = await importEmail(mailboxId, "doomed");

		await setLock(mailboxId, false);
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}?purge=true`,
			{ method: "DELETE" },
		);

		expect(await countKeys(`raw/${doomedEmailId}.eml`)).toBe(0);
		expect(await countKeys(`raw/${otherEmailId}.eml`)).toBe(1);
		expect(await countKeys(`attachments/${otherEmailId}/`)).toBe(1);
		expect(await readSettings(other)).not.toBeNull();
	});

	// A claim on a mailbox that no longer exists would be inherited by the
	// next mailbox registered at the same address.
	it("drops the claim on a purged mailbox", async () => {
		// @ts-expect-error test binding
		const authStub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		expect(await authStub.getPersonMailboxes("user1")).toContain(mailboxId);

		await setLock(mailboxId, false);
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}?purge=true`,
			{ method: "DELETE" },
		);

		expect(await authStub.getPersonMailboxes("user1")).not.toContain(mailboxId);
	});
});
