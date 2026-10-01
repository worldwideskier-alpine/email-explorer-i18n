import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKeyPrefix } from "../../src/auto-backup";
import { type NightStatus, nightFor } from "../../src/mailbox-night";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A mailbox's night runs in its own object's alarm (mailbox-night.ts), and
 * the runtime runs an alarm again when an attempt did not finish -- ended at
 * its fifteen minutes, say, which it does without a word. Running the whole
 * night again would most likely end the same way, once per retry, and the
 * screen would go on saying nothing. So an alarm that finds its night already
 * under way finishes the record instead.
 */

const NIGHT = new Date("2026-10-01T18:00:00.000Z");
const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const stub = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
// The pool types this with an untyped stub, which a typed one is not.
const fireAlarm = () =>
	runDurableObjectAlarm(stub() as unknown as DurableObjectStub);

async function backupsOn() {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				settings: {
					autoBackup: { enabled: true, frequency: "daily", keep: 7 },
				},
			}),
		},
	);
	expect(res.status).toBe(200);
}

async function settings() {
	const object = (await bucket().get(
		`mailboxes/${mailboxId}.json`,
	)) as R2ObjectBody;
	return object.json<{
		autoBackup?: { lastResult?: { ok: boolean; error?: string } };
	}>();
}

async function archives() {
	const listed = await bucket().list({ prefix: backupKeyPrefix(mailboxId) });
	return listed.objects.map((o) => o.key);
}

describe("a mailbox's night in its alarm", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await backupsOn();
	});

	it("finishes the record, rather than the night, when it was ended partway", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		const underWay: NightStatus = {
			...nightFor(mailbox as never, NIGHT),
			state: "running",
			backup: { state: "running", messages: 0 },
		};
		expect(nightFor(mailbox as never, NIGHT).backup.state).toBe("waiting");
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", { mailbox, status: underWay });
			// Far off, so it fires only when the test says.
			await state.storage.setAlarm(Date.now() + 60 * 60_000);
		});

		expect(await fireAlarm()).toBe(true);

		const status = (await stub().nightStatus(
			NIGHT.toISOString(),
		)) as NightStatus | null;
		expect(status?.state).toBe("done");
		expect(status?.backup.state).toBe("failed");
		const result = (await settings()).autoBackup?.lastResult;
		expect(result?.ok).toBe(false);
		expect(result?.error).toContain("ended by the runtime");
		// Not run a second time.
		expect(await archives()).toEqual([]);
	});

	it("runs the night it was given", async () => {
		const mailbox = { id: mailboxId, settings: await settings() };
		await runInDurableObject(stub(), async (_i, state) => {
			await state.storage.put("night", {
				mailbox,
				status: nightFor(mailbox as never, NIGHT),
			});
			await state.storage.setAlarm(Date.now() + 60 * 60_000);
		});

		expect(await fireAlarm()).toBe(true);

		const status = (await stub().nightStatus(
			NIGHT.toISOString(),
		)) as NightStatus | null;
		expect(status?.state).toBe("done");
		expect(status?.backup.state).toBe("ran");
		expect(await archives()).toHaveLength(1);
		expect((await settings()).autoBackup?.lastResult?.ok).toBe(true);
	});
});
