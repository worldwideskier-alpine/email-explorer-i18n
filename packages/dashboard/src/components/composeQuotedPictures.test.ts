import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * A picture in a message that is replied to or forwarded.
 *
 * The quote went into the editor as stored, `<img src="cid:...">` and all,
 * and nothing was attached under that id: the picture was broken in the
 * editor and in the message sent. It is now shown by its address here, and
 * on the way out that address goes back to a `cid:` with the picture
 * attached under it -- an address here would name the mailbox to the
 * recipient and open nothing for them.
 */

const replyToEmail = vi.fn(async (..._a: unknown[]) => ({ data: {} }));
const forwardEmail = vi.fn(async (..._a: unknown[]) => ({ data: {} }));
const sendEmail = vi.fn(async (..._a: unknown[]) => ({ data: {} }));
const getAttachment = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		replyToEmail: (...a: unknown[]) => replyToEmail(...a),
		forwardEmail: (...a: unknown[]) => forwardEmail(...a),
		sendEmail: (...a: unknown[]) => sendEmail(...a),
		getAttachment: (...a: unknown[]) => getAttachment(...a),
		deleteEmail: vi.fn(async () => ({})),
		saveDraft: vi.fn(async () => ({ data: { id: "d1" } })),
	},
}));

const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PATH = "/api/v1/mailboxes/m@example.com/emails/parent-1/attachments/a1";

let host: HTMLElement;
let unmount = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	for (const fn of [replyToEmail, forwardEmail, sendEmail]) fn.mockClear();
	getAttachment.mockReset();
	getAttachment.mockResolvedValue({
		data: new Blob([PICTURE], { type: "image/png" }),
		headers: {
			"content-disposition": `attachment; filename="logo.png"; filename*=UTF-8''logo.png`,
		},
	});
});
afterEach(() => {
	unmount();
	host.remove();
});

const settle = async () => {
	for (let i = 0; i < 8; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

const PARENT = {
	id: "parent-1",
	subject: "Our logo",
	sender: "them@example.org",
	recipient: "m@example.com",
	date: "2026-09-01T00:00:00.000Z",
	read: true,
	starred: false,
	folder_id: "inbox",
	body: '<p>Here it is: <img src="cid:logo@example.org" alt="logo"></p>',
	attachments: [
		{
			id: "a1",
			filename: "logo.png",
			mimetype: "image/png",
			size: 4,
			content_id: "<logo@example.org>",
			disposition: "inline",
		},
		{
			id: "a2",
			filename: "terms.pdf",
			mimetype: "application/pdf",
			size: 9,
			disposition: "attachment",
		},
	],
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
	useUIStore().openComposeModal(options as never);
	await settle();
}

const setTo = async (address: string) => {
	const field = host.querySelector('input[type="email"], input#to') as
		| HTMLInputElement
		| undefined;
	if (!field) return;
	field.value = address;
	field.dispatchEvent(new Event("input"));
	await nextTick();
};

const press = async (label: string) => {
	const button = [...host.querySelectorAll("button")].find((b) =>
		b.textContent?.includes(label),
	) as HTMLButtonElement;
	expect(button, label).toBeTruthy();
	button.click();
	await settle();
};

type Sent = {
	html: string;
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[];
};
const sentBy = (fn: typeof replyToEmail) =>
	(fn.mock.calls[0] as unknown[])[2] as Sent;

describe("a quoted picture", () => {
	it("shows in the editor, by its address here", async () => {
		await openComposer({ mode: "forward", originalEmail: PARENT });
		const img = host.querySelector(".ProseMirror img, [contenteditable] img");
		expect(img?.getAttribute("src")).toBe(PATH);
		expect(host.innerHTML).not.toContain("cid:");
	});

	it("goes with a forward, attached under the id the HTML names", async () => {
		await openComposer({ mode: "forward", originalEmail: PARENT });
		await setTo("friend@example.net");
		await press("compose.send");

		expect(getAttachment).toHaveBeenCalledWith(
			"m@example.com",
			"parent-1",
			"a1",
		);
		const sent = sentBy(forwardEmail);
		expect(sent.html).toContain('src="cid:a1"');
		expect(sent.html).not.toContain("/api/v1/");
		expect(sent.attachments).toEqual([
			{
				content: btoa(String.fromCharCode(...PICTURE)),
				filename: "logo.png",
				type: "image/png",
				disposition: "inline",
				contentId: "a1",
			},
		]);
	});

	it("goes with a reply too", async () => {
		await openComposer({ mode: "reply", originalEmail: PARENT });
		await press("compose.send");

		const sent = sentBy(replyToEmail);
		expect(sent.html).toContain('src="cid:a1"');
		expect(sent.html).not.toContain("/api/v1/");
		expect(sent.attachments?.map((a) => a.contentId)).toEqual(["a1"]);
	});

	it("goes from a resumed draft, which remembers nothing but its HTML", async () => {
		await openComposer({
			mode: "draft",
			originalEmail: {
				id: "draft-1",
				subject: "Fwd: Our logo",
				sender: "m@example.com",
				recipient: "friend@example.net",
				date: "2026-09-02T00:00:00.000Z",
				read: true,
				starred: false,
				folder_id: "drafts",
				body: `<p>See</p><p><img src="${PATH}"></p>`,
			},
		});
		await press("compose.send");

		// Through the email store, which sends (mailbox, message).
		const sent = (sendEmail.mock.calls[0] as unknown[])[1] as Sent;
		expect(sent.html).toContain('src="cid:a1"');
		expect(sent.attachments?.map((a) => a.contentId)).toEqual(["a1"]);
	});

	it("stops the send when the picture cannot be fetched", async () => {
		getAttachment.mockRejectedValue({ response: { status: 500 } });
		await openComposer({ mode: "reply", originalEmail: PARENT });
		await press("compose.send");

		expect(replyToEmail).not.toHaveBeenCalled();
		expect(host.textContent).toContain("common.loadFailed");
	});

	it("is left out of a quote from spam, as before", async () => {
		await openComposer({
			mode: "reply",
			originalEmail: { ...PARENT, folder_id: "spam" },
		});
		expect(host.querySelector("[contenteditable] img")).toBeNull();
		await press("compose.send");

		expect(getAttachment).not.toHaveBeenCalled();
		expect(sentBy(replyToEmail).attachments).toBeUndefined();
	});
});
