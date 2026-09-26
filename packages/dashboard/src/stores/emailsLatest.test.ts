import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The list and the open message show the answer to the last request made,
 * not the last answer to arrive.
 *
 * Switching folders while the first is still loading used to leave the first
 * folder's rows under the second folder's name when its answer came back
 * late -- inbox rows under "Trash", where delete is permanent.
 */

type Pending = { resolve: (value: unknown) => void };
const pending: Record<string, Pending> = {};
const deferred = (key: string) =>
	new Promise((resolve) => {
		pending[key] = { resolve };
	});

const moveEmail = vi.fn(async () => ({ data: {} }));
const deleteEmail = vi.fn(async () => ({ data: {} }));

vi.mock("@/services/api", () => ({
	default: {
		listEmails: (_mailbox: string, params: { folder: string }) =>
			deferred(`list:${params.folder}`),
		getEmail: (_mailbox: string, id: string) => deferred(`email:${id}`),
		moveEmail: (...args: unknown[]) => moveEmail(...(args as [])),
		deleteEmail: (...args: unknown[]) => deleteEmail(...(args as [])),
	},
}));

const { useEmailStore } = await import("./emails");

const row = (id: string, folder: string) => ({
	id,
	subject: id,
	sender: "a@example.org",
	recipient: "me@example.com",
	date: "2026-09-01T00:00:00.000Z",
	read: false,
	starred: false,
	folder_id: folder,
});

beforeEach(() => {
	setActivePinia(createPinia());
	moveEmail.mockClear();
	deleteEmail.mockClear();
});

describe("switching folders while one is loading", () => {
	it("shows the folder switched to, whichever answer arrives last", async () => {
		const store = useEmailStore();
		const inbox = store.fetchEmails("m", { folder: "inbox" });
		const trash = store.fetchEmails("m", { folder: "trash" });

		pending["list:trash"].resolve({ data: [row("t1", "trash")] });
		await trash;
		pending["list:inbox"].resolve({ data: [row("i1", "inbox")] });
		await inbox;

		expect(store.emails.map((e) => e.id)).toEqual(["t1"]);
		expect(store.listKey).toBe("m/trash");
	});

	it("and still takes an answer that arrives in order", async () => {
		const store = useEmailStore();
		const inbox = store.fetchEmails("m", { folder: "inbox" });
		pending["list:inbox"].resolve({ data: [row("i1", "inbox")] });
		await inbox;
		expect(store.emails.map((e) => e.id)).toEqual(["i1"]);
	});
});

describe("opening one message and then another", () => {
	it("shows the second, whichever answer arrives last", async () => {
		const store = useEmailStore();
		const first = store.fetchEmail("m", "a");
		const second = store.fetchEmail("m", "b");

		pending["email:b"].resolve({ data: row("b", "inbox") });
		await second;
		pending["email:a"].resolve({ data: row("a", "inbox") });
		await first;

		expect(store.currentEmail?.id).toBe("b");
	});
});

describe("deleting from a list", () => {
	/**
	 * Even with the rows wrong about the folder on screen, a message is
	 * destroyed only when it is itself in the trash.
	 */
	it("moves a row that is not in the trash, whatever folder is showing", async () => {
		const store = useEmailStore();
		store.emails = [row("i1", "inbox")];
		store.listKey = "m/trash";

		expect(store.deletesPermanently("i1")).toBe(false);
		await store.deleteOrTrashEmail("m", "i1");

		expect(deleteEmail).not.toHaveBeenCalled();
		expect(moveEmail).toHaveBeenCalledWith("m", "i1", "trash");
	});

	it("deletes a row in the trash for good", async () => {
		const store = useEmailStore();
		store.emails = [row("t1", "trash")];

		expect(store.deletesPermanently("t1")).toBe(true);
		await store.deleteOrTrashEmail("m", "t1");

		expect(deleteEmail).toHaveBeenCalledWith("m", "t1");
		expect(moveEmail).not.toHaveBeenCalled();
	});
});
