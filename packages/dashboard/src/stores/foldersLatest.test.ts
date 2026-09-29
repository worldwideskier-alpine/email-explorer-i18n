import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The folders of the mailbox that is open, and of no other.
 *
 * Moved to another mailbox, the sidebar listed the last one's folders until
 * the new ones arrived -- or for good, if that failed -- and an answer that
 * came back late for the previous mailbox replaced the new one's.
 */

const pending = new Map<string, (rows: unknown[]) => void>();
vi.mock("@/services/api", () => ({
	default: {
		listFolders: (id: string) =>
			new Promise((resolve) =>
				pending.set(id, (rows) => resolve({ data: rows })),
			),
	},
}));

const { useFolderStore } = await import("./folders");

describe("the folders", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		pending.clear();
	});

	it("of the last mailbox are gone as soon as the next is asked for", async () => {
		const store = useFolderStore();
		const a = store.fetchFolders("a@example.com");
		pending.get("a@example.com")?.([{ id: "fa", name: "A's" }]);
		await a;
		expect(store.folders).toHaveLength(1);

		void store.fetchFolders("b@example.com");
		expect(store.folders).toEqual([]);
	});

	it("of a mailbox no longer asked about are not shown when they arrive", async () => {
		const store = useFolderStore();
		const a = store.fetchFolders("a@example.com");
		const b = store.fetchFolders("b@example.com");
		pending.get("b@example.com")?.([{ id: "fb", name: "B's" }]);
		await b;
		pending.get("a@example.com")?.([{ id: "fa", name: "A's" }]);
		await a;
		expect(store.folders.map((f) => f.name)).toEqual(["B's"]);
	});
});
