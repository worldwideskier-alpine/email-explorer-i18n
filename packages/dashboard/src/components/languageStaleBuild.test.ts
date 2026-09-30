import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { toastText, useToast } from "@/composables/useToast";
import { englishWith } from "@/testing/english";

/**
 * Picking a language on a page left open over a deploy.
 *
 * That page asks for the catalogue its own build named, and a deploy does not
 * serve an earlier build's files: measured on production, the page itself
 * comes back in their place and the import fails. Picking a language then did
 * nothing at all. The new build has the catalogue, so the choice is kept and
 * the page reloaded into it -- but not over somebody's writing.
 */

const setLocale = vi.fn();
const rememberLocale = vi.fn();
vi.mock("@/i18n", async (importActual) => ({
	...(await importActual<typeof import("@/i18n")>()),
	setLocale: (...a: unknown[]) => setLocale(...a),
	rememberLocale: (...a: unknown[]) => rememberLocale(...a),
}));

const aNewBuildIsServed = vi.fn();
const reload = vi.fn();
vi.mock("@/services/appUpdate", async (importActual) => ({
	...(await importActual<typeof import("@/services/appUpdate")>()),
	aNewBuildIsServed: () => aNewBuildIsServed(),
	reloading: { now: () => reload() },
}));

let host: HTMLElement;
let writing: HTMLTextAreaElement | null = null;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	for (const f of [setLocale, rememberLocale, aNewBuildIsServed, reload]) {
		f.mockReset();
	}
	// What a failed dynamic import does.
	setLocale.mockRejectedValue(
		new TypeError("Failed to fetch dynamically imported module"),
	);
	const { toasts } = useToast();
	toasts.value = [];
});
afterEach(() => {
	unmount();
	host.remove();
	writing?.remove();
	writing = null;
});

const settle = async () => {
	for (let i = 0; i < 4; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function pick(code: string) {
	const { default: LanguageSwitcher } = await import("./LanguageSwitcher.vue");
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith({}) as never);
	i18n.global.locale.value = "en" as never;
	const app = createApp(LanguageSwitcher).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await nextTick();
	const select = host.querySelector("select") as HTMLSelectElement;
	select.value = code;
	select.dispatchEvent(new Event("change"));
	await settle();
	return select;
}

const NOTICE = (englishWith({}) as { header: { reloadForLanguage: string } })
	.header.reloadForLanguage;

describe("a language that will not load", () => {
	it("reloads into the chosen language when a newer build is served", async () => {
		aNewBuildIsServed.mockResolvedValue(true);
		await pick("de");
		expect(rememberLocale).toHaveBeenCalledWith("de");
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("does not reload over somebody's writing, and says a reload will do it", async () => {
		aNewBuildIsServed.mockResolvedValue(true);
		writing = document.createElement("textarea");
		writing.value = "half a reply";
		document.body.appendChild(writing);

		await pick("de");
		expect(reload).not.toHaveBeenCalled();
		// Kept, so the reload they make opens in it.
		expect(rememberLocale).toHaveBeenCalledWith("de");
		expect(useToast().toasts.value.map(toastText)).toEqual([NOTICE]);
	});

	it("is left as it was when no newer build is served", async () => {
		aNewBuildIsServed.mockResolvedValue(false);
		const select = await pick("de");
		expect(reload).not.toHaveBeenCalled();
		expect(rememberLocale).not.toHaveBeenCalled();
		expect(select.value).toBe("en");
	});
});
