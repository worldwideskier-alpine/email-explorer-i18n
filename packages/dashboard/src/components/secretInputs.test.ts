import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import SecretInput from "./SecretInput.vue";

/**
 * Secrets that are not passwords -- API keys, the Turnstile secret -- are
 * kept out of password managers' reach.
 *
 * A type=password box makes the browser take its form for a sign-in form: it
 * filled root's own address and password into the Turnstile keys, and it
 * offers to save an API key as this site's password, which it then fills into
 * the sign-in form.
 */

const screens = import.meta.glob("../**/*.vue", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

/** Every <input ...> tag, attributes and all, quoted values kept whole. */
const inputTags = (source: string) =>
	source.match(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) ?? [];

let host: HTMLElement;
let unmount = () => {};
afterEach(() => {
	unmount();
	host?.remove();
});

describe("a password-typed box", () => {
	it("is only ever a real password, and says which kind", () => {
		const unmarked: string[] = [];
		for (const [file, source] of Object.entries(screens)) {
			for (const tag of inputTags(source)) {
				if (!/\btype="password"/.test(tag)) continue;
				if (/\bautocomplete="(current|new)-password"/.test(tag)) continue;
				unmarked.push(`${file}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`);
			}
		}
		expect(unmarked).toEqual([]);
	});

	it("is found by the check above, which would otherwise pass on nothing", () => {
		const found = Object.values(screens).flatMap(inputTags);
		expect(
			found.filter((t) => /\btype="password"/.test(t)).length,
		).toBeGreaterThan(5);
	});
});

describe("SecretInput", () => {
	it("is a masked text box that password managers are told to leave alone", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		const value = ref("first");
		const app = createApp({
			render: () =>
				h(SecretInput, {
					id: "key",
					placeholder: "sk-...",
					class: "w-full",
					modelValue: value.value,
					"onUpdate:modelValue": (v: string) => {
						value.value = v;
					},
				}),
		});
		app.mount(host);
		unmount = () => app.unmount();
		await nextTick();

		const box = host.querySelector("#key") as HTMLInputElement;
		expect(box.type).toBe("text");
		expect(box.getAttribute("autocomplete")).toBe("off");
		expect(box.hasAttribute("data-1p-ignore")).toBe(true);
		expect(box.getAttribute("data-lpignore")).toBe("true");
		expect(box.hasAttribute("data-bwignore")).toBe(true);
		expect(box.className).toContain("[-webkit-text-security:disc]");
		expect(box.className).toContain("w-full");
		expect(box.placeholder).toBe("sk-...");
		expect(box.value).toBe("first");

		box.value = "typed";
		box.dispatchEvent(new Event("input"));
		expect(value.value).toBe("typed");
	});
});
