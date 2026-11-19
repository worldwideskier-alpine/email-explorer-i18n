import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { useToast } from "@/composables/useToast";

/**
 * Attachments stay within reach once the dialog's middle scrolls.
 *
 * The middle used to squeeze the message instead of scrolling, which kept the
 * attachments on screen by painting them over it (composeBodyRoom.test.ts).
 * With the message keeping its room, the attachments are below it and the
 * middle scrolls past them. Measured in Chromium with only that fixed: a
 * dialog opened with nothing attached showed no way to attach at six of seven
 * sizes; a file just added was out of sight at every size measured; and a
 * refusal, said only in the banner at the top of the middle, was out of sight
 * in 16 of 20 tries, at every size but the tallest. So the paperclip is also
 * in the row of buttons below the middle, which does not scroll; a refusal
 * is a toast as well whenever the banner is out of sight (on a phone the
 * toast sits on Send for three seconds, so not when it shows); and the files
 * just added are scrolled into view, unless somebody is at work elsewhere in
 * the dialog -- focused elsewhere, or having pressed, typed or scrolled
 * there while they were read. With those, in Japanese at eight sizes from
 * 1920x950 to 320x568, each new, with Cc and Bcc open and as a forward: the
 * paperclip pressable at open, the file and the note under it in view once
 * added, and the refusal of a 21MB file in sight -- 24 of 24 each.
 *
 * The row of buttons wraps. Three buttons that shrink no further than their
 * longest word, in a dialog that cut off what overflowed, lost part of a
 * button in 68 of the 73 languages at 320x568, and all of "Save Draft" in
 * English; now nothing in the dialog sticks out in any of the 73 at
 * 320x568, 375x667, 414x896 or 568x320. The paperclip is an icon at every
 * width: with its name beside it the row took a second line at 1366x768 in
 * nine languages. And the dialog scrolls where even the wrapped row is
 * taller than it has room for (320x256, a 1280x1024 screen at 400%), where
 * hiding the overflow put Send out of reach in 51 of the 73.
 */

const forwardEmail = vi.fn(async (..._a: unknown[]) => ({ data: {} }));
const getAttachment = vi.fn();
vi.mock("@/services/api", () => ({
	default: {
		forwardEmail: (...a: unknown[]) => forwardEmail(...a),
		sendEmail: vi.fn(async () => ({ data: {} })),
		getAttachment: (...a: unknown[]) => getAttachment(...a),
		saveDraft: vi.fn(async () => ({ data: { id: "d" } })),
		deleteEmail: vi.fn(async () => ({})),
	},
}));

// A limit small enough to pass with a few bytes. The reading itself keeps
// the real one; only the dialog's own checks read this.
const LIMIT = 10;
vi.mock("@/utils/attachments", async (actual) => ({
	...((await actual()) as object),
	MAX_TOTAL_ATTACHMENT_BYTES: 10,
}));

const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const WITH_A_PICTURE = {
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
			size: PICTURE.length,
			content_id: "<logo@example.org>",
			disposition: "inline",
		},
	],
};

let host: HTMLElement;
let unmount = () => {};
// jsdom has no scrollIntoView; a browser does.
const scrolled = vi.fn();

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	HTMLElement.prototype.scrollIntoView = scrolled;
	scrolled.mockClear();
	forwardEmail.mockClear();
	getAttachment.mockReset();
	getAttachment.mockResolvedValue({
		data: new Blob([PICTURE], { type: "image/png" }),
		headers: { "content-disposition": 'attachment; filename="logo.png"' },
	});
	useToast().toasts.value = [];
});
afterEach(() => {
	unmount();
	host.remove();
	delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
	vi.restoreAllMocks();
});

const settle = async () => {
	for (let i = 0; i < 8; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function openComposer(options: object = { mode: "new" }) {
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

/** Files as the picker hands them over; a plain object stands in for one
 * that is too big to make, or that cannot be read. */
async function pick(...files: (File | { name: string; size: number })[]) {
	const input = host.querySelector("#attachments") as HTMLInputElement;
	Object.defineProperty(input, "files", { value: files, configurable: true });
	input.dispatchEvent(new Event("change"));
	await settle();
}

/** A file whose read waits until `release`. */
function heldFile(name: string) {
	let release = () => {};
	const file = new File(["a"], name, { type: "text/plain" });
	Object.defineProperty(file, "arrayBuffer", {
		value: () =>
			new Promise<ArrayBuffer>((done) => {
				release = () => done(new Uint8Array([97]).buffer);
			}),
	});
	return { file, release: () => release() };
}

const middle = () => host.querySelector("form > .overflow-y-auto") as Element;
const banner = () => host.querySelector('form [role="alert"]');
const rows = () => host.querySelectorAll("#attachments ~ ul > li");
const errorToasts = () =>
	useToast()
		.toasts.value.filter((toast) => toast.type === "error")
		.map((toast) =>
			// A string was translated once and frozen there (AGENTS.md); it
			// must not pass for the function that says it in today's language.
			typeof toast.message === "function"
				? toast.message()
				: `frozen: ${toast.message}`,
		);

describe("the paperclip in the row of buttons", () => {
	it("is outside the middle that scrolls, and opens the file picker", async () => {
		await openComposer();
		const paperclip = host.querySelector(
			'button[title="compose.attachments"]',
		) as HTMLButtonElement;
		expect(paperclip, "the paperclip").not.toBeNull();
		expect(middle().contains(paperclip)).toBe(false);
		expect(paperclip.closest("form")).not.toBeNull();
		// Its name is there for a screen reader where only the icon shows.
		expect(paperclip.textContent?.trim()).toBe("compose.attachments");

		const opened = vi
			.spyOn(HTMLInputElement.prototype, "click")
			.mockImplementation(() => {});
		paperclip.click();
		expect(opened.mock.contexts).toContain(host.querySelector("#attachments"));
	});

	it("shares a row that wraps, rather than one the dialog cuts off", async () => {
		await openComposer();
		const row = host.querySelector('button[title="compose.attachments"]')
			?.parentElement as Element;
		expect([...row.classList]).toContain("flex-wrap");
		// And where even the wrapped row is taller than the dialog has room
		// for, the dialog scrolls rather than hiding Send below its edge.
		const box = host.querySelector("form")?.parentElement as Element;
		expect([...box.classList]).toContain("overflow-y-auto");
		expect([...box.classList]).not.toContain("overflow-hidden");
	});

	it("is the paperclip alone at every width, its name for screen readers", async () => {
		await openComposer();
		const name = host.querySelector(
			'button[title="compose.attachments"] span',
		) as Element;
		// Shown beside it from some width up, the row took a second line in
		// nine languages at 1366x768.
		expect([...name.classList]).toEqual(["sr-only"]);
	});

	it("keeps its focus while a file is read, though the picker is disabled", async () => {
		await openComposer();
		const paperclip = host.querySelector(
			'button[title="compose.attachments"]',
		) as HTMLButtonElement;
		paperclip.focus();
		const slow = heldFile("slow.txt");
		await pick(slow.file);
		expect(
			(host.querySelector("#attachments") as HTMLInputElement).disabled,
		).toBe(true);
		expect(paperclip.disabled).toBe(false);
		expect(document.activeElement).toBe(paperclip);
		slow.release();
		await settle();
		expect(rows()).toHaveLength(1);
	});
});

describe("a refusal about attachments", () => {
	it("is a toast when the files picked are over the limit", async () => {
		await openComposer();
		await pick({ name: "big.bin", size: LIMIT + 1 });
		expect(rows()).toHaveLength(0);
		expect(banner()?.textContent).toContain("compose.attachmentTooLarge");
		expect(errorToasts()).toEqual(["compose.attachmentTooLarge"]);
	});

	it("is a toast when a file picked cannot be read", async () => {
		await openComposer();
		// No arrayBuffer to read it with.
		await pick({ name: "gone.txt", size: 1 });
		expect(rows()).toHaveLength(0);
		expect(banner()?.textContent).toContain("compose.attachmentReadFailed");
		expect(errorToasts()).toEqual(["compose.attachmentReadFailed"]);
	});

	it("is a toast when the quoted pictures take the message over the limit at send", async () => {
		await openComposer({ mode: "forward", originalEmail: WITH_A_PICTURE });
		await pick(new File(["1234567"], "notes.txt", { type: "text/plain" }));
		expect(rows()).toHaveLength(1);
		const to = host.querySelector("#to") as HTMLInputElement;
		to.value = "friend@example.net";
		to.dispatchEvent(new Event("input"));
		await nextTick();
		(host.querySelector('button[type="submit"]') as HTMLButtonElement).click();
		await settle();

		expect(getAttachment).toHaveBeenCalled();
		expect(forwardEmail).not.toHaveBeenCalled();
		expect(banner()?.textContent).toContain("compose.attachmentTooLarge");
		expect(errorToasts()).toEqual(["compose.attachmentTooLarge"]);
	});

	it("is the banner alone while the banner is in sight", async () => {
		// Laid out as a browser would, with the banner inside what the middle
		// shows: on a phone a toast as well sat on Send for three seconds.
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				return this.getAttribute("role") === "alert"
					? new DOMRect(0, 10, 300, 40)
					: new DOMRect(0, 0, 300, 400);
			},
		);
		await openComposer();
		await pick({ name: "big.bin", size: LIMIT + 1 });
		expect(banner()?.textContent).toContain("compose.attachmentTooLarge");
		expect(errorToasts()).toEqual([]);
	});
});

describe("files just added", () => {
	it("are scrolled into view, with the note under them", async () => {
		await openComposer();
		const note = () => host.querySelector("#attachments ~ ul + p");
		// Focus on nothing, on the paperclip, on the picker: the last two can
		// still have it when the list is drawn (measured in Chromium).
		for (const [i, focused] of [
			null,
			'button[title="compose.attachments"]',
			"#attachments",
		].entries()) {
			if (focused) (host.querySelector(focused) as HTMLElement).focus();
			await pick(new File([`${i}`], `${i}.txt`, { type: "text/plain" }));
			expect(note(), "the note under the list").not.toBeNull();
			expect(scrolled.mock.contexts.at(-1), String(focused)).toBe(note());
			expect(scrolled).toHaveBeenCalledTimes(i + 1);
		}
		expect(rows()).toHaveLength(3);
		expect(scrolled.mock.calls.at(-1)?.[0]).toEqual({ block: "nearest" });
		expect(host.querySelector('[role="alert"]')).toBeNull();
	});

	it("leave the middle where it is if somebody did anything in the dialog while they were read", async () => {
		await openComposer();
		const slow = heldFile("slow.txt");
		await pick(slow.file);
		// As pressing "Add Cc / Bcc" does: the button goes, and focus with it.
		host
			.querySelector("form")
			?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		slow.release();
		await settle();
		expect(rows()).toHaveLength(1);
		expect(document.activeElement).toBe(document.body);
		expect(scrolled).not.toHaveBeenCalled();
	});

	it("leave the middle where it is while somebody is typing elsewhere", async () => {
		await openComposer();
		(host.querySelector("#subject") as HTMLInputElement).focus();
		await pick(new File(["a"], "a.txt", { type: "text/plain" }));
		expect(rows()).toHaveLength(1);
		expect(scrolled).not.toHaveBeenCalled();
	});

	it("are not reported as unread where nothing can scroll them into view", async () => {
		// As jsdom is: no scrollIntoView at all.
		delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
		await openComposer();
		await pick(new File(["a"], "a.txt", { type: "text/plain" }));
		expect(rows()).toHaveLength(1);
		expect(host.querySelector('[role="alert"]')).toBeNull();
		expect(errorToasts()).toEqual([]);
	});
});
