import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * The message keeps its room in the compose dialog however much is above
 * and below it.
 *
 * The dialog's middle is a flex column that scrolls. The message's wrapper
 * was told it may shrink (`min-h-0`), so once the fields and the list of
 * attachments needed more than the dialog had, the wrapper shrank instead of
 * the middle scrolling, and the attachments were painted over the message --
 * reported on 2026-11-19 with one attachment. Measured in Chromium against
 * the production bundle, in Japanese, seven sizes from 1730x1040 to
 * 320x568, one attachment, before -> after:
 *
 *   plain text      painted under the attachments by 11-308px  -> 0
 *   rich editor     2px tall on a phone, all 23 toolbar buttons
 *                   covered; 32px to type in at 1366x768       -> 300px at
 *                   least, 105-213px of it to type in, nothing covered
 *   its HTML view   cut off at the editor's edge by 133-508px
 *                   (59px with nothing attached)               -> 0
 *
 * Re-measured in English, Arabic, Hebrew, Japanese and dark mode at eleven
 * sizes down to 568x320, with plain, rich, long, HTML view, reply and
 * forward and 0, 1 and 6 attachments: nothing overlapped or was cut off.
 *
 * jsdom lays nothing out, so this holds the rule the layout follows rather
 * than the layout: a flex item may not shrink below its content unless it
 * gives up that floor -- an explicit min-height, overflow other than
 * visible, a fixed height or cap, or size containment (CSS Flexbox 4.5).
 * Everything between the scrolling middle and the message must keep it;
 * whatever gives it up must set a floor of its own. Mounted, so a wrapper
 * added later, and classes the editor takes from its parent, are seen: a
 * test reading the source for a class string missed a new inner wrapper
 * with `min-h-0`, tried. Re-measure in a browser after changing any of it.
 */

vi.mock("@/services/api", () => ({
	default: {
		sendEmail: vi.fn(async () => ({ data: {} })),
		saveDraft: vi.fn(async () => ({ data: { id: "d" } })),
		deleteEmail: vi.fn(async () => ({})),
	},
}));

let host: HTMLElement;
let unmount = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
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
	const middle = host.querySelector("form > .overflow-y-auto");
	expect(middle, "the dialog's scrolling middle").not.toBeNull();
	return middle as HTMLElement;
}

/** The classes by which `el` gives up a flex item's floor of its content. */
const floorGivenUp = (el: Element): string[] =>
	[...el.classList].filter((name) => {
		const bare = name.split(":").pop() ?? name;
		return (
			// Any min-height replaces the automatic one.
			/^min-h-(?!auto$)/.test(bare) ||
			// Hidden or scrolling on either axis makes a scroll container.
			/^overflow(-[xy])?-(hidden|auto|scroll|clip)$/.test(bare) ||
			/^(max-)?h-(?!auto$)/.test(bare) ||
			/^contain-(size|strict)$/.test(bare)
		);
	});

/** Everything from `el`'s parent up to, not including, `top`. */
const between = (el: Element, top: Element): Element[] => {
	const chain: Element[] = [];
	for (let at = el.parentElement; at && at !== top; at = at.parentElement) {
		chain.push(at);
	}
	expect(chain.at(-1)?.parentElement, "inside the middle").toBe(top);
	return chain;
};

describe("the message keeps its room in the compose dialog", () => {
	it("as plain text: nothing between it and the scrolling middle may shrink", async () => {
		const middle = await openComposer();
		(
			middle.querySelector('input[type="checkbox"]') as HTMLInputElement
		).click();
		await settle();
		const box = middle.querySelector("textarea") as HTMLTextAreaElement;
		expect(box).not.toBeNull();
		expect([...box.classList]).toContain("min-h-[300px]");
		for (const wrapper of between(box, middle)) {
			expect(floorGivenUp(wrapper), wrapper.className).toEqual([]);
		}
	});

	it("in the editor: it sets its own floor, since it gives the automatic one up", async () => {
		const middle = await openComposer();
		const editor = middle.querySelector(".rich-text-editor") as HTMLElement;
		expect(editor).not.toBeNull();
		for (const wrapper of between(editor, middle)) {
			expect(floorGivenUp(wrapper), wrapper.className).toEqual([]);
		}
		const own = [...editor.classList];
		// Its own `overflow-hidden` (the rounded corners) already gives the
		// automatic floor up, so the floor has to be written down.
		expect(own).toContain("min-h-[300px]");
		expect(own).not.toContain("min-h-0");
		// A long message must not raise the wrapper's floor with it: it
		// scrolls inside the editor, under a toolbar that stays in view.
		expect(own).toContain("contain-size");
		// ...which needs the editor to be a column and its content to scroll.
		expect(own).toEqual(expect.arrayContaining(["flex", "flex-col"]));
		const content = editor.querySelector(".ProseMirror")?.parentElement;
		expect([...(content?.classList ?? [])]).toEqual(
			expect.arrayContaining(["flex-1", "min-h-0", "overflow-y-auto"]),
		);
	});

	it("in the editor's HTML view: the box has no floor that could pass the editor's edge", async () => {
		const middle = await openComposer();
		(
			middle.querySelector(
				'[title="richTextEditor.toggleSourceCode"]',
			) as HTMLButtonElement
		).click();
		await settle();
		const source = middle.querySelector(
			".rich-text-editor textarea",
		) as HTMLTextAreaElement;
		expect(source).not.toBeNull();
		const own = [...source.classList];
		expect(own.filter((name) => /^min-h-\[/.test(name))).toEqual([]);
		expect(own).toContain("min-h-0");
		// Nor anything between it and the editor, which is held to its size:
		// a wrapper that kept its floor took the box's 300px as its own.
		const editor = source.closest(".rich-text-editor") as HTMLElement;
		for (const wrapper of between(source, editor)) {
			expect(floorGivenUp(wrapper), wrapper.className).not.toEqual([]);
		}
		// Where nothing holds the editor to a height -- the signature on
		// Settings -- the box still starts at 300px.
		expect(own).toContain("basis-[300px]");
	});
});
