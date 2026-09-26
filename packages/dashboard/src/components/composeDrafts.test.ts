import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * What a draft keeps: its line breaks when written as plain text, and which
 * message it answers when it is a reply.
 */

const saveDraft = vi.fn(async () => ({ data: { id: "d1" } }));
const updateDraft = vi.fn(async () => ({ data: { id: "d1" } }));
const replyToEmail = vi.fn(async () => ({ data: {} }));
const sendEmail = vi.fn(async () => ({ data: {} }));

vi.mock("@/services/api", () => ({
	default: {
		saveDraft: (...a: unknown[]) => saveDraft(...(a as [])),
		updateDraft: (...a: unknown[]) => updateDraft(...(a as [])),
		replyToEmail: (...a: unknown[]) => replyToEmail(...(a as [])),
		sendEmail: (...a: unknown[]) => sendEmail(...(a as [])),
		forwardEmail: vi.fn(async () => ({ data: {} })),
		deleteEmail: vi.fn(async () => ({})),
	},
}));

let host: HTMLElement;
let unmount = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	for (const fn of [saveDraft, updateDraft, replyToEmail, sendEmail]) {
		fn.mockClear();
	}
});
afterEach(() => {
	unmount();
	host.remove();
});

const settle = async () => {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

const PARENT = {
	id: "parent-1",
	subject: "Question",
	sender: "them@example.org",
	recipient: "m@example.com",
	date: "2026-09-01T00:00:00.000Z",
	read: true,
	starred: false,
	folder_id: "inbox",
	body: "<p>Can you?</p>",
};

async function openComposer(options: object) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const { default: ComposeEmail } = await import("./ComposeEmail.vue");
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{
				path: "/mailbox/:mailboxId/emails/:folder",
				component: { render: () => h("div") },
			},
		],
	});
	const app = createApp({ render: () => [h(RouterView), h(ComposeEmail)] });
	app
		.use(pinia)
		.use(router)
		.use(
			createI18n({
				legacy: false,
				locale: "en",
				messages: { en: {} },
				missingWarn: false,
				fallbackWarn: false,
			}),
		);
	await router.push("/mailbox/m%40example.com/emails/inbox");
	await router.isReady();
	app.mount(host);
	unmount = () => app.unmount();

	const { useMailboxStore } = await import("@/stores/mailboxes");
	useMailboxStore().currentMailbox = {
		id: "m@example.com",
		email: "m@example.com",
		name: "Mine",
		settings: {},
	} as never;
	const { useUIStore } = await import("@/stores/ui");
	useUIStore().openComposeModal(options as never);
	await settle();
}

const press = async (label: string) => {
	const button = [...host.querySelectorAll("button")].find((b) =>
		b.textContent?.includes(label),
	) as HTMLButtonElement;
	expect(button, label).toBeTruthy();
	button.click();
	await settle();
};

describe("a draft written as plain text", () => {
	/**
	 * Saved as it was, it came back through the rich editor as one paragraph:
	 * every line break gone.
	 */
	it("is saved as HTML that keeps its lines", async () => {
		await openComposer({ mode: "new", originalEmail: null });
		const plain = host.querySelector(
			'input[type="checkbox"]',
		) as HTMLInputElement;
		plain.click();
		await settle();
		const box = host.querySelector("textarea") as HTMLTextAreaElement;
		box.value = "line one\nline two";
		box.dispatchEvent(new Event("input"));
		await nextTick();

		await press("compose.saveDraft");

		const sent = (saveDraft.mock.calls[0] as unknown[])[1] as { html: string };
		expect(sent.html).not.toBe("line one\nline two");
		const doc = new DOMParser().parseFromString(sent.html, "text/html");
		expect(doc.body.innerText ?? doc.body.textContent).toMatch(
			/line one[\s\S]*line two/,
		);
		expect(sent.html).toMatch(/line one(<br>|<\/p>)/);
	});
});

describe("a reply saved as a draft", () => {
	it("records the message it answers", async () => {
		await openComposer({ mode: "reply", originalEmail: PARENT });
		await press("compose.saveDraft");
		expect((saveDraft.mock.calls[0] as unknown[])[1]).toMatchObject({
			replyTo: "parent-1",
		});
	});

	/**
	 * Resumed, it used to go out as a new message -- no In-Reply-To, no
	 * References, a thread of its own on the other side.
	 */
	it("is sent as a reply when resumed", async () => {
		await openComposer({
			mode: "draft",
			originalEmail: {
				...PARENT,
				id: "d1",
				folder_id: "draft",
				recipient: "them@example.org",
				subject: "Re: Question",
				draft_reply_to: "parent-1",
			},
		});
		(host.querySelector("form") as HTMLFormElement).dispatchEvent(
			new Event("submit"),
		);
		await settle();

		expect(sendEmail).not.toHaveBeenCalled();
		expect(replyToEmail).toHaveBeenCalledOnce();
		expect((replyToEmail.mock.calls[0] as unknown[])[1]).toBe("parent-1");
	});
});

describe("a reply with nothing to reply to", () => {
	/**
	 * Its own reason was thrown translated and then dropped by a catch that
	 * read only the server's answer -- "an unexpected error".
	 */
	it("says why", async () => {
		await openComposer({ mode: "reply", originalEmail: null });
		(host.querySelector("form") as HTMLFormElement).dispatchEvent(
			new Event("submit"),
		);
		await settle();
		expect(replyToEmail).not.toHaveBeenCalled();
		expect(host.textContent).toContain("compose.originalEmailNotFound");
		expect(host.textContent).not.toContain("compose.unexpectedError");
	});
});
