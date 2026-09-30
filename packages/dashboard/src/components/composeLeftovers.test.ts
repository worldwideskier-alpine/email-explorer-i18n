import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * The composer, mounted for real, for what one message leaves to the next and
 * what a picked file costs before it is refused.
 *
 * A file still being read when the dialog closed finished into the next
 * message composed, and went to whoever that was addressed to. A file far over
 * the limit was read and encoded whole -- freezing the tab -- before the limit
 * was looked at. And a forwarded message's date went into the editor as HTML.
 */

const sendEmail = vi.fn(async (..._a: unknown[]) => ({ data: {} }));
const forwardEmail = vi.fn(async (..._a: unknown[]) => ({ data: {} }));
vi.mock("@/services/api", () => ({
	default: {
		sendEmail: (...a: unknown[]) => sendEmail(...a),
		forwardEmail: (...a: unknown[]) => forwardEmail(...a),
		saveDraft: vi.fn(async () => ({ data: { id: "d" } })),
		deleteEmail: vi.fn(async () => ({})),
	},
}));

// Each read held open until the test lets it finish.
const reads: (() => void)[] = [];
const fileToAttachment = vi.fn(
	(file: File) =>
		new Promise((resolve) => {
			reads.push(() =>
				resolve({
					id: file.name,
					filename: file.name,
					type: "text/plain",
					size: file.size,
					content: "YWJj",
				}),
			);
		}),
);
vi.mock("@/utils/attachments", async (actual) => ({
	...((await actual()) as object),
	fileToAttachment: (file: File) => fileToAttachment(file),
}));

let host: HTMLElement;
let unmount = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	sendEmail.mockClear();
	forwardEmail.mockClear();
	fileToAttachment.mockClear();
	reads.length = 0;
});
afterEach(() => {
	unmount();
	host.remove();
	document.body.innerHTML = "";
});

const settle = async () => {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function mountComposer() {
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
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith() as never);
	i18n.global.locale.value = "en" as never;
	await router.push("/mailbox/m%40example.com/emails/inbox");
	await router.isReady();
	app.use(pinia).use(router).use(i18n);
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
	return useUIStore();
}

async function address(to: string) {
	const field = host.querySelector("#to") as HTMLInputElement;
	field.value = to;
	field.dispatchEvent(new Event("input"));
	await nextTick();
}

function pick(file: File) {
	const input = host.querySelector("#attachments") as HTMLInputElement;
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	input.dispatchEvent(new Event("change"));
}

const submit = () =>
	host
		.querySelector("form")
		?.dispatchEvent(new Event("submit", { cancelable: true }));

describe("a file still being read when the composer closes", () => {
	it("does not ride along on the next message", async () => {
		const ui = await mountComposer();
		ui.openComposeModal({ mode: "new", originalEmail: null } as never);
		await settle();
		pick(new File(["abc"], "for-alice.txt", { type: "text/plain" }));
		await settle();
		expect(fileToAttachment).toHaveBeenCalledOnce();

		ui.closeComposeModal();
		await settle();
		ui.openComposeModal({ mode: "new", originalEmail: null } as never);
		await settle();
		reads[0]();
		await settle();

		expect(host.textContent).not.toContain("for-alice.txt");
		const send = host.querySelector(
			'button[type="submit"]',
		) as HTMLButtonElement;
		expect(send.disabled, "the old read does not hold Send").toBe(false);

		await address("bob@example.net");
		submit();
		await settle();
		expect(sendEmail).toHaveBeenCalledOnce();
		expect(sendEmail.mock.calls[0][1]).not.toHaveProperty("attachments");
	});
});

describe("a file over the limit", () => {
	it("is refused before it is read", async () => {
		const { MAX_TOTAL_ATTACHMENT_BYTES } = await import("@/utils/attachments");
		const ui = await mountComposer();
		ui.openComposeModal({ mode: "new", originalEmail: null } as never);
		await settle();

		const huge = new File(["x"], "huge.iso");
		Object.defineProperty(huge, "size", {
			value: MAX_TOTAL_ATTACHMENT_BYTES + 1,
		});
		pick(huge);
		await settle();

		expect(fileToAttachment).not.toHaveBeenCalled();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			"more than the 20.0 MB limit",
		);
	});

	it("counts what is already attached", async () => {
		const { MAX_TOTAL_ATTACHMENT_BYTES } = await import("@/utils/attachments");
		const ui = await mountComposer();
		ui.openComposeModal({ mode: "new", originalEmail: null } as never);
		await settle();

		const half = (name: string) => {
			const file = new File(["x"], name);
			Object.defineProperty(file, "size", {
				value: MAX_TOTAL_ATTACHMENT_BYTES / 2 + 1,
			});
			return file;
		};
		pick(half("first.bin"));
		await settle();
		reads[0]();
		await settle();
		expect(fileToAttachment).toHaveBeenCalledOnce();

		pick(half("second.bin"));
		await settle();
		expect(fileToAttachment).toHaveBeenCalledOnce();
	});
});

describe("a forwarded message's date", () => {
	/**
	 * A date that does not parse is shown as it came, and it came from the
	 * sender. Unescaped, an image in it was fetched the moment the forward
	 * opened, and went out in it.
	 */
	it("goes into the editor as text", async () => {
		const ui = await mountComposer();
		ui.openComposeModal({
			mode: "forward",
			originalEmail: {
				id: "e1",
				sender: "a@example.net",
				recipient: "m@example.com",
				subject: "Hello",
				date: '<img src="https://example.net/pixel.gif">',
				body: "<p>body</p>",
				folder_id: "inbox",
			},
		} as never);
		await settle();

		const editor = host.querySelector('[contenteditable="true"]');
		expect(editor?.querySelector("img")).toBeNull();
		expect(editor?.textContent).toContain('<img src="https://example.net');

		await address("bob@example.net");
		submit();
		await settle();
		expect(forwardEmail).toHaveBeenCalledOnce();
		const sent = forwardEmail.mock.calls[0][2] as { html: string };
		expect(sent.html).not.toMatch(/<img/i);
	});
});
