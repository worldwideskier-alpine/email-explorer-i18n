import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * A message's attachments can be reached however short the screen.
 *
 * The message card is held to the height of the page, and the frame that
 * shows the message will not shrink under 150px. The card hid what did not
 * fit, so on a phone or a short window the attachments below the frame were
 * cut off where nobody could scroll to them. Measured in Chromium, in
 * Japanese, a message of sixty lines, download buttons out of reach, before
 * -> after:
 *
 *   320x568   1 of 1, 3 of 3, 8 of 8, 20 of 20          -> 0
 *   375x667   2 of 3, 7 of 8, 19 of 20                  -> 0
 *   1366x768  8 of 20; 1280x720 12 of 20; 1024x768 11 of 20;
 *             768x1024 10 of 20                         -> 0
 *   667x375   every one, and 82px of the message shown  -> 0, 150px
 *   568x320   every one, and 0px of the message shown   -> 0, 150px
 *
 * The move-to-folder menu, which opens inside the card, likewise went from
 * 1 of 4 entries pressable at 568x320 to 4 of 4.
 *
 * The card scrolls instead (overflow-y-auto). Where everything fits, the
 * frame takes up the difference and the card never scrolls.
 *
 * jsdom lays nothing out, so this holds the rules rather than the screen: the
 * card may scroll on the vertical axis; nothing between it and a download
 * button hides what overflows it; and nothing between it and the frame gives
 * up the floor the frame sets (CSS Flexbox 4.5) -- a wrapper with min-h-0 or
 * hidden overflow took the frame to 0px at 568x320 and at 320x568, measured,
 * with every button still in reach. Re-measure in a browser after changing
 * it.
 */

vi.mock("@/services/api", () => ({
	default: {
		getEmail: vi.fn(async () => ({
			data: {
				id: "e1",
				subject: "s",
				sender: "a@example.org",
				recipient: "m@example.com",
				date: "2026-09-01T00:00:00.000Z",
				read: true,
				starred: false,
				folder_id: "inbox",
				body: "<p>x</p>",
				attachments: [
					{
						id: "a1",
						filename: "plan.pdf",
						mimetype: "application/pdf",
						size: 10,
						opensInline: true,
					},
					{
						id: "a2",
						filename: "files.zip",
						mimetype: "application/zip",
						size: 10,
						opensInline: false,
					},
				],
			},
		})),
		updateEmail: vi.fn(async () => ({})),
		listFolders: vi.fn(async () => ({ data: [] })),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

vi.mock("@/components/EmailIframe.vue", () => ({
	default: defineComponent({
		render: () => h("div", { "data-test": "frame" }),
	}),
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
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function openMessage() {
	setActivePinia(createPinia());
	const { default: EmailDetail } = await import("./EmailDetail.vue");
	const blank = { render: () => h("div") };
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{
				path: "/mailbox/:mailboxId/email/:id",
				name: "EmailDetail",
				component: EmailDetail,
			},
			{
				path: "/mailbox/:mailboxId/emails/:folder",
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
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith({}) as never);
	i18n.global.locale.value = "en" as never;
	await router.push("/mailbox/m%40example.com/email/e1?fromFolder=inbox");
	await router.isReady();
	const app = createApp({ render: () => h(RouterView) });
	app.use(router).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

/** A class as it applies, whatever its variants and importance. */
const bare = (name: string): string =>
	(name.split(":").pop() ?? name).replace(/^!|!$/g, "");

/** Classes by which an element hides what overflows it vertically. */
const hidesOverflow = (el: Element): string[] =>
	[...el.classList].filter(
		(name) =>
			/^overflow(-y)?-(hidden|clip)$/.test(bare(name)) ||
			/^\[overflow(-y)?:(hidden|clip)\]$/.test(bare(name)),
	);

/** Classes by which a flex item gives up the floor of its content. */
const floorGivenUp = (el: Element): string[] =>
	[...el.classList].filter((name) => {
		const it = bare(name);
		return (
			/^min-h-(?!auto$)/.test(it) ||
			/^overflow(-[xy])?-(hidden|auto|scroll|clip)$/.test(it) ||
			/^(max-)?h-(?!auto$)/.test(it) ||
			/^contain-(size|strict)$/.test(it)
		);
	});

/** Everything from `el`'s parent up to, not including, `top`. */
const between = (el: Element, top: Element): Element[] => {
	expect(top.contains(el), "inside the card").toBe(true);
	const chain: Element[] = [];
	for (let at = el.parentElement; at && at !== top; at = at.parentElement) {
		chain.push(at);
	}
	return chain;
};

describe("a message's attachments", () => {
	it("are inside a card that scrolls rather than cuts them off", async () => {
		await openMessage();
		const frame = host.querySelector('[data-test="frame"]') as Element;
		const card = frame.closest(".h-full") as Element;
		expect(card, "the message card").not.toBeNull();
		expect([...card.classList]).toContain("overflow-y-auto");
		expect(hidesOverflow(card)).toEqual([]);
		expect(card.getAttribute("style") ?? "").not.toMatch(/overflow/);
		// A scrollbar that takes room is drawn dark in dark mode too.
		expect([...card.classList]).toContain("dark:[color-scheme:dark]");

		const downloads = [...host.querySelectorAll('button[title="Download"]')];
		expect(downloads).toHaveLength(2);
		for (const button of downloads) {
			for (const at of between(button, card)) {
				expect(hidesOverflow(at), at.className).toEqual([]);
			}
		}
	});

	it("leave the message its frame's floor while the card scrolls", async () => {
		await openMessage();
		const frame = host.querySelector('[data-test="frame"]') as Element;
		const card = frame.closest(".h-full") as Element;
		for (const wrapper of between(frame, card)) {
			expect(floorGivenUp(wrapper), wrapper.className).toEqual([]);
		}
	});
});
