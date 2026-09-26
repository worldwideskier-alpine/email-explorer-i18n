import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * A spam message is treated as spam however it was reached.
 *
 * The open message used to take its folder from the `fromFolder` query
 * parameter. The folder list sets it; a search result did not, so spam opened
 * from search was shown as if from the inbox -- images fetched, links live --
 * and the same parameter decided whether delete was permanent. And a reply or
 * forward put the message's own HTML into the editor, which is part of this
 * page with images on, so the tracker fired there instead.
 *
 * Mounted for real: what is being held is what the screen hands to the frame
 * and the editor, not what the source says.
 */

const frameProps: Record<string, unknown>[] = [];
const editorValues: string[] = [];

vi.mock("@/components/EmailIframe.vue", () => ({
	default: defineComponent({
		props: ["body", "disableLinks", "blockRemoteContent"],
		setup(props) {
			return () => {
				frameProps.push({ ...props });
				return h("div");
			};
		},
	}),
}));

vi.mock("@/components/RichTextEditor.vue", () => ({
	default: defineComponent({
		props: ["modelValue"],
		setup(props) {
			return () => {
				editorValues.push(String(props.modelValue ?? ""));
				return h("div");
			};
		},
	}),
}));

const TRACKER = "https://tracker.invalid/open.gif";

let stored: Record<string, unknown>;
const moveEmail = vi.fn(async () => ({ data: {} }));
const deleteEmail = vi.fn(async () => ({ data: {} }));

vi.mock("@/services/api", () => ({
	default: {
		getEmail: vi.fn(async () => ({ data: stored })),
		listFolders: vi.fn(async () => ({ data: [] })),
		updateEmail: vi.fn(async () => ({ data: {} })),
		moveEmail: (...args: unknown[]) => moveEmail(...(args as [])),
		deleteEmail: (...args: unknown[]) => deleteEmail(...(args as [])),
	},
}));

const { default: EmailDetail } = await import("./EmailDetail.vue");
const { default: ComposeEmail } = await import("@/components/ComposeEmail.vue");
const { useUIStore } = await import("@/stores/ui");

const message = (folder: string, extra: Record<string, unknown> = {}) => ({
	id: "e1",
	subject: "Hello",
	sender: "someone@example.org",
	recipient: "me@example.com",
	date: "2026-09-01T00:00:00.000Z",
	read: true,
	starred: false,
	body: `<p>Words</p><img src="${TRACKER}">`,
	attachments: [],
	folder_id: folder,
	...extra,
});

let host: HTMLElement;
let unmount: () => void;

async function open(path: string) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const blank = defineComponent({ render: () => h("div") });
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{
				path: "/mailbox/:mailboxId/email/:id",
				name: "EmailDetail",
				component: EmailDetail,
			},
			{
				path: "/mailbox/:mailboxId/:folder",
				name: "EmailList",
				component: blank,
			},
			{
				path: "/mailbox/:mailboxId/email/:id/source",
				name: "EmailSource",
				component: blank,
			},
		],
	});
	const i18n = createI18n({
		legacy: false,
		locale: "en",
		messages: { en: {} },
		missingWarn: false,
		fallbackWarn: false,
	});
	const app = createApp({
		render: () => [h(RouterView), h(ComposeEmail)],
	});
	app.use(pinia).use(router).use(i18n);
	await router.push(path);
	await router.isReady();
	app.mount(host);
	unmount = () => app.unmount();
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

const lastFrame = () => frameProps[frameProps.length - 1];
const lastEditor = () => editorValues[editorValues.length - 1] ?? "";
const button = (title: string) =>
	host.querySelector(`[title="${title}"]`) as HTMLButtonElement | null;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	frameProps.length = 0;
	editorValues.length = 0;
	moveEmail.mockClear();
	deleteEmail.mockClear();
});

afterEach(() => {
	unmount?.();
	host.remove();
	vi.unstubAllGlobals();
});

describe("a spam message opened without the folder in the address", () => {
	beforeEach(async () => {
		stored = message("spam");
		await open("/mailbox/me%40example.com/email/e1");
	});

	it("is shown with nothing loaded and no live links", () => {
		expect(lastFrame()).toMatchObject({
			blockRemoteContent: true,
			disableLinks: true,
		});
	});

	it("offers 'not spam'", () => {
		expect(button("emailDetail.markNotSpam")).not.toBeNull();
	});

	for (const [mode, title] of [
		["reply", "emailDetail.reply"],
		["forward", "emailDetail.forward"],
	] as const) {
		it(`quotes only the words into a ${mode}`, async () => {
			useUIStore().openComposeModal({ mode, originalEmail: stored });
			await nextTick();
			await nextTick();
			expect(lastEditor(), title).toContain("Words");
			expect(lastEditor()).not.toContain("<img");
			expect(lastEditor()).not.toContain(TRACKER);
		});
	}
});

describe("a message outside spam", () => {
	it("is quoted with its markup, as before", async () => {
		stored = message("inbox");
		await open("/mailbox/me%40example.com/email/e1?fromFolder=inbox");
		expect(lastFrame()).toMatchObject({ blockRemoteContent: false });
		useUIStore().openComposeModal({ mode: "reply", originalEmail: stored });
		await nextTick();
		await nextTick();
		expect(lastEditor()).toContain("<img");
	});

	/**
	 * The sender's words go into HTML the editor parses; a subject that is a
	 * tag became one, so an image in a subject line was a tracker in every
	 * forward, spam or not.
	 */
	it("carries a subject and sender as text, not markup", async () => {
		stored = message("inbox", {
			subject: `<img src="${TRACKER}">`,
			sender: `<img src="${TRACKER}">@example.org`,
		});
		await open("/mailbox/me%40example.com/email/e1?fromFolder=inbox");
		useUIStore().openComposeModal({ mode: "forward", originalEmail: stored });
		await nextTick();
		await nextTick();
		const html = lastEditor();
		const doc = new DOMParser().parseFromString(html, "text/html");
		// The body's own image is expected; the subject and sender must not
		// have added two more.
		expect(doc.querySelectorAll("img")).toHaveLength(1);
		expect(html).toContain("&lt;img");
	});
});

describe("deleting an open message", () => {
	/**
	 * Permanent only when the message is in the trash. The address saying
	 * "trash" is not enough -- it is only where the reader came from.
	 */
	it("moves an inbox message to the trash even when opened from the trash", async () => {
		stored = message("inbox");
		await open("/mailbox/me%40example.com/email/e1?fromFolder=trash");
		const confirm = vi.fn(() => true);
		vi.stubGlobal("confirm", confirm);

		const remove = button("emailList.delete");
		expect(remove).not.toBeNull();
		remove?.click();
		await nextTick();

		expect(confirm).not.toHaveBeenCalled();
		expect(deleteEmail).not.toHaveBeenCalled();
		expect(moveEmail).toHaveBeenCalledWith("me@example.com", "e1", "trash");
	});

	it("deletes a message in the trash for good, after asking", async () => {
		stored = message("trash");
		await open("/mailbox/me%40example.com/email/e1");
		const confirm = vi.fn(() => true);
		vi.stubGlobal("confirm", confirm);

		const remove = button("emailList.delete");
		expect(remove).not.toBeNull();
		remove?.click();
		await nextTick();

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(deleteEmail).toHaveBeenCalledWith("me@example.com", "e1");
	});
});
