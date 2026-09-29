import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { englishWith } from "@/testing/english";

/**
 * Whether the signed-in person has a sending key.
 *
 * A request for it that failed was read as "none": "Not set" in red to
 * somebody who had a key, and the one button that removes it hidden.
 */

const adminGetResendSettings = vi.fn();
vi.mock("@/services/api", () => ({
	default: {
		adminGetResendSettings: (...a: unknown[]) => adminGetResendSettings(...a),
		adminSetResendApiKey: vi.fn(),
	},
}));

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	adminGetResendSettings.mockReset();
});
afterEach(() => {
	unmount();
	host.remove();
});

const settle = async () => {
	for (let i = 0; i < 4; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function mountCard() {
	const { default: ResendKeyCard } = await import("./ResendKeyCard.vue");
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith({}) as never);
	i18n.global.locale.value = "en" as never;
	const app = createApp(ResendKeyCard).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

const NOT_SET = () =>
	(englishWith({}) as { admin: { resend: { sourceNone: string } } }).admin
		.resend.sourceNone;
const button = (text: string) =>
	[...host.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === text,
	) as HTMLButtonElement | undefined;

describe("the sending key's box", () => {
	it("gives a password manager nothing to fill", async () => {
		// A password box here was one the browser offered to save the key
		// from, as this site's password -- and then filled into sign-in.
		adminGetResendSettings.mockResolvedValue({ data: { source: "none" } });
		await mountCard();
		expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0);
		const box = host.querySelector("#resendApiKey") as HTMLInputElement;
		expect(box.type).toBe("text");
		expect(box.className).toContain("[-webkit-text-security:disc]");
	});
});

describe("the sending key's status", () => {
	it("is not said to be unset when it could not be asked", async () => {
		adminGetResendSettings.mockRejectedValue(new Error("offline"));
		await mountCard();
		expect(host.textContent).not.toContain(NOT_SET());
		expect(host.textContent).toContain(
			"Could not load. Check your connection and try again.",
		);
	});

	it("is asked again, and a stored key can then be removed", async () => {
		adminGetResendSettings.mockRejectedValueOnce(new Error("offline"));
		adminGetResendSettings.mockResolvedValue({ data: { source: "stored" } });
		await mountCard();
		button("Try again")?.click();
		await settle();
		expect(adminGetResendSettings).toHaveBeenCalledTimes(2);
		expect(button("Remove")).toBeTruthy();
	});

	it("is still said to be unset when it is", async () => {
		adminGetResendSettings.mockResolvedValue({ data: { source: "none" } });
		await mountCard();
		expect(host.textContent).toContain(NOT_SET());
	});
});
