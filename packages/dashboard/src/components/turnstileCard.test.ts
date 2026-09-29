import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import type { TurnstileOptions } from "@/services/turnstile";
import { englishWith } from "@/testing/english";

/**
 * Root's Turnstile card: a pair is tried as soon as both keys are in, and can
 * be saved only once that try has passed -- for exactly the pair that passed.
 * A pair saved unchecked would refuse every sign-in, root's included, and this
 * card is behind the sign-in.
 *
 * Turnstile itself is a stand-in on `window`, which is where the real script
 * puts it; the test hands the widget's token over by calling its callback.
 */

const getTurnstile = vi.fn();
const verifyTurnstile = vi.fn();
const setTurnstile = vi.fn();
const deleteTurnstile = vi.fn();
const getAppSettings = vi.fn();
vi.mock("@/services/api", () => ({
	default: {
		getTurnstile: (...a: unknown[]) => getTurnstile(...a),
		verifyTurnstile: (...a: unknown[]) => verifyTurnstile(...a),
		setTurnstile: (...a: unknown[]) => setTurnstile(...a),
		deleteTurnstile: (...a: unknown[]) => deleteTurnstile(...a),
		getAppSettings: (...a: unknown[]) => getAppSettings(...a),
	},
}));

let widgets: { sitekey: string; options: TurnstileOptions }[] = [];
const turnstile = {
	render: vi.fn((_el: HTMLElement, options: TurnstileOptions) => {
		widgets.push({ sitekey: options.sitekey, options });
		return String(widgets.length);
	}),
	reset: vi.fn(),
	remove: vi.fn(),
};

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	widgets = [];
	window.turnstile = turnstile;
	for (const f of [
		getTurnstile,
		verifyTurnstile,
		setTurnstile,
		deleteTurnstile,
		getAppSettings,
	]) {
		f.mockReset();
	}
	getTurnstile.mockResolvedValue({ data: { siteKey: null, secretKey: null } });
	getAppSettings.mockResolvedValue({ data: {} });
});
afterEach(() => {
	unmount();
	host.remove();
	delete window.turnstile;
});

const settle = async () => {
	for (let i = 0; i < 4; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};
/** Past the pause the card waits for typing to stop. */
const typingStops = async () => {
	await new Promise((r) => setTimeout(r, 800));
	await settle();
};

async function mountCard() {
	const { default: TurnstileCard } = await import("./TurnstileCard.vue");
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith({}) as never);
	i18n.global.locale.value = "en" as never;
	const app = createApp(TurnstileCard).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

const text = (key: string) =>
	(englishWith({}) as { root: { turnstile: Record<string, string> } }).root
		.turnstile[key];
const input = (id: string) => host.querySelector(`#${id}`) as HTMLInputElement;
function type(id: string, value: string) {
	const field = input(id);
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
}
const button = (label: string) =>
	[...host.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === label,
	) as HTMLButtonElement;

async function enterPair(siteKey: string, secretKey: string) {
	type("turnstileSiteKey", siteKey);
	type("turnstileSecretKey", secretKey);
	await typingStops();
}

describe("the Turnstile card", () => {
	it("says what is in force, the secret by its tail", async () => {
		getTurnstile.mockResolvedValue({
			data: { siteKey: "0x4SITE", secretKey: "...bnQA" },
		});
		await mountCard();
		expect(host.textContent).toContain("0x4SITE");
		expect(host.textContent).toContain("...bnQA");
		expect(input("turnstileSiteKey").value).toBe("0x4SITE");
		expect(input("turnstileSecretKey").value).toBe("");
		expect(button(text("remove"))).toBeTruthy();
	});

	it("tries the pair once both are in, and saves only after it passed", async () => {
		verifyTurnstile.mockResolvedValue({ data: { status: "verified" } });
		setTurnstile.mockResolvedValue({
			data: { siteKey: "0x4SITE", secretKey: "...CRET" },
		});
		await mountCard();

		type("turnstileSiteKey", "0x4SITE");
		await typingStops();
		expect(widgets).toHaveLength(0);
		expect(button(text("save")).disabled).toBe(true);

		type("turnstileSecretKey", "0x4SECRET");
		await typingStops();
		expect(widgets.map((w) => w.sitekey)).toEqual(["0x4SITE"]);
		expect(button(text("save")).disabled).toBe(true);

		widgets[0].options.callback("token-1");
		await settle();
		expect(verifyTurnstile).toHaveBeenCalledWith(
			"0x4SITE",
			"0x4SECRET",
			"token-1",
		);
		expect(host.textContent).toContain(text("passed"));
		expect(button(text("save")).disabled).toBe(false);

		button(text("save")).click();
		await settle();
		expect(setTurnstile).toHaveBeenCalledWith("0x4SITE", "0x4SECRET");
		expect(host.textContent).toContain(text("saved"));
		expect(input("turnstileSecretKey").value).toBe("");
		// The sign-in forms in this tab learn of it without a reload.
		expect(getAppSettings).toHaveBeenCalled();
	});

	it("will not save a pair that failed, and says why", async () => {
		verifyTurnstile.mockRejectedValue({
			response: {
				status: 400,
				data: { verdict: "refused", codes: ["invalid-input-response"] },
			},
		});
		await mountCard();
		await enterPair("0x4SITE", "0x4OTHER");
		widgets[0].options.callback("token-1");
		await settle();
		expect(host.textContent).toContain(text("mismatch"));
		expect(button(text("save")).disabled).toBe(true);
	});

	it("stops offering to save once the secret is changed after passing", async () => {
		verifyTurnstile.mockResolvedValue({ data: { status: "verified" } });
		await mountCard();
		await enterPair("0x4SITE", "0x4SECRET");
		widgets[0].options.callback("token-1");
		await settle();
		expect(button(text("save")).disabled).toBe(false);

		type("turnstileSecretKey", "0x4SECRET2");
		await nextTick();
		expect(button(text("save")).disabled).toBe(true);
	});

	it("does not wipe what was typed before the stored keys arrived", async () => {
		let answer: (value: unknown) => void = () => {};
		getTurnstile.mockReturnValue(new Promise((r) => (answer = r)));
		await mountCard();
		type("turnstileSecretKey", "0x4TYPED");
		answer({ data: { siteKey: "0x4SITE", secretKey: "...bnQA" } });
		await settle();
		expect(input("turnstileSecretKey").value).toBe("0x4TYPED");
		expect(host.textContent).toContain("...bnQA");
	});

	it("gives a password manager nothing to fill", async () => {
		// With the secret as a password field, the browser took the pair for
		// a sign-in form and filled in root's own address and password.
		await mountCard();
		expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0);
		for (const id of ["turnstileSiteKey", "turnstileSecretKey"]) {
			expect(input(id).type).toBe("text");
			expect(input(id).getAttribute("autocomplete")).toBe("off");
		}
		// Masked all the same, by CSS.
		expect(input("turnstileSecretKey").className).toContain(
			"[-webkit-text-security:disc]",
		);
	});

	it("says so when Turnstile throws on the site key instead of answering", async () => {
		turnstile.render.mockImplementationOnce(() => {
			throw new Error('[Cloudflare Turnstile] Invalid input for "sitekey"');
		});
		await mountCard();
		await enterPair("someone@example.com", "password123");
		expect(host.textContent).toContain(text("widgetFailed"));
		expect(host.textContent).not.toContain(text("waiting"));
		expect(button(text("save")).disabled).toBe(true);
	});

	it("says so when the widget will not render with the site key", async () => {
		await mountCard();
		await enterPair("0x4WRONG", "0x4SECRET");
		widgets[0].options["error-callback"]?.("110200");
		await settle();
		expect(host.textContent).toContain(text("widgetFailed"));
		expect(verifyTurnstile).not.toHaveBeenCalled();
		expect(button(text("save")).disabled).toBe(true);
	});
});
