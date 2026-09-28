import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * A file still being read when Send is pressed.
 *
 * A picked file is read and encoded before it joins the message, which takes
 * a moment for a large one on a phone. Send was not held back meanwhile: the
 * message went out without the file, "sent" was shown, and the file landed in
 * the list of a dialog that had already closed.
 */

const sendEmail = vi.fn(async () => ({ data: {} }));
vi.mock("@/services/api", () => ({
	default: {
		sendEmail: (...a: unknown[]) => sendEmail(...(a as [])),
		saveDraft: vi.fn(async () => ({ data: { id: "d" } })),
		deleteEmail: vi.fn(async () => ({})),
	},
}));

// The read, held open until the test lets it finish.
let finishReading: () => void = () => {};
vi.mock("@/utils/attachments", async (actual) => {
	const real = (await actual()) as Record<string, unknown>;
	return {
		...real,
		fileToAttachment: (file: File) =>
			new Promise((resolve) => {
				finishReading = () =>
					resolve({
						id: "a1",
						filename: file.name,
						type: "text/plain",
						size: 3,
						content: "YWJj",
					});
			}),
	};
});

let host: HTMLElement;
let unmount = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	sendEmail.mockClear();
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

async function openComposer() {
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
	await router.push("/mailbox/m%40example.com/emails/inbox");
	await router.isReady();
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
	useUIStore().openComposeModal({ mode: "new", originalEmail: null } as never);
	await settle();

	const to = host.querySelector("#to") as HTMLInputElement;
	to.value = "you@example.org";
	to.dispatchEvent(new Event("input"));
	await nextTick();
}

function pickFile() {
	const input = host.querySelector("#attachments") as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: [new File(["abc"], "notes.txt", { type: "text/plain" })],
		configurable: true,
	});
	input.dispatchEvent(new Event("change"));
}

const sendButton = () =>
	host.querySelector('button[type="submit"]') as HTMLButtonElement;
const submit = () =>
	host
		.querySelector("form")
		?.dispatchEvent(new Event("submit", { cancelable: true }));

describe("sending while a file is still being read", () => {
	it("is held back, by the button and by the form alike", async () => {
		await openComposer();
		pickFile();
		await settle();

		expect(sendButton().disabled).toBe(true);
		submit();
		await settle();
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("sends the file once it has been read", async () => {
		await openComposer();
		pickFile();
		await settle();
		finishReading();
		await settle();

		expect(sendButton().disabled).toBe(false);
		submit();
		await settle();
		expect(sendEmail).toHaveBeenCalledOnce();
		const sent = (sendEmail.mock.calls[0] as unknown[])[1] as {
			attachments?: { filename: string }[];
		};
		expect(sent.attachments?.map((a) => a.filename)).toEqual(["notes.txt"]);
	});
});
