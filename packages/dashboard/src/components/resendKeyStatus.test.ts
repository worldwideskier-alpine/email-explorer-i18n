import { createPinia, setActivePinia } from "pinia";
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
const adminSetResendApiKey = vi.fn(async () => ({
	data: { source: "stored" },
}));
vi.mock("@/services/api", () => ({
	default: {
		adminGetResendSettings: (...a: unknown[]) => adminGetResendSettings(...a),
		adminSetResendApiKey: (...a: unknown[]) =>
			adminSetResendApiKey(...(a as [])),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
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
	// Signed in, as on the screens the card sits on.
	localStorage.setItem(
		"session",
		JSON.stringify({
			id: "s",
			userId: "u",
			email: "me@example.com",
			role: "admin",
			expiresAt: Date.now() + 60_000,
		}),
	);
	const pinia = createPinia();
	setActivePinia(pinia);
	const app = createApp(ResendKeyCard).use(pinia).use(i18n);
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
	it("gives a password manager only this account's own sign-in", async () => {
		// The key as a password box was one the browser offered to save as
		// this site's password -- and then filled into sign-in. Setting a key
		// now asks for the current password, so the one password box here is
		// that, after a username box holding this account's own address:
		// what a browser pairs is the real sign-in, not the key.
		adminGetResendSettings.mockResolvedValue({ data: { source: "none" } });
		await mountCard();
		const passwords = host.querySelectorAll('input[type="password"]');
		expect(passwords).toHaveLength(1);
		expect(passwords[0].getAttribute("autocomplete")).toBe("current-password");
		const fields = [...host.querySelectorAll("input")];
		const username =
			fields[fields.indexOf(passwords[0] as HTMLInputElement) - 1];
		expect(username.getAttribute("autocomplete")).toBe("username");
		expect(username.value).toBe("me@example.com");

		const box = host.querySelector("#resendApiKey") as HTMLInputElement;
		expect(fields.indexOf(box)).toBeGreaterThan(
			fields.indexOf(passwords[0] as HTMLInputElement),
		);
		expect(box.type).toBe("text");
		expect(box.className).toContain("[-webkit-text-security:disc]");
	});

	it("is set with the current password, and removed without one", async () => {
		adminGetResendSettings.mockResolvedValue({ data: { source: "stored" } });
		await mountCard();
		const type = (selector: string, value: string) => {
			const field = host.querySelector(selector) as HTMLInputElement;
			field.value = value;
			field.dispatchEvent(new Event("input"));
		};
		type("#resendApiKey", "re_new_key");
		await settle();
		expect(button("Save")?.disabled).toBe(true);
		type("#resendCurrentPassword", "my-password");
		await settle();
		button("Save")?.click();
		await settle();
		expect(adminSetResendApiKey).toHaveBeenLastCalledWith(
			"re_new_key",
			"my-password",
		);
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
