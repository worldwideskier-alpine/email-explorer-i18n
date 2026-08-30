import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createI18n, useI18n } from "vue-i18n";
import { useLocalizedMessage } from "./useLocalizedMessage";

/**
 * A stored message has to follow a language change like every other line does.
 *
 * The failure this guards against is quiet: a save confirmation or an error
 * written into a ref renders correctly, and keeps rendering correctly, right
 * up until someone switches language while it is on screen -- at which point
 * that one line stays in the old language and nothing reports it. It was found
 * by hand on the settings page, where "Saved." and "It has not run yet."
 * stayed Japanese after a switch to English.
 *
 * Components here are built with render functions rather than templates: the
 * dashboard's vitest config resolves `vue` to the runtime-only build, which
 * has no template compiler.
 */

const messages = {
	en: { greeting: "Hello", named: "Hello, {who}" },
	ja: { greeting: "こんにちは", named: "こんにちは、{who}" },
};

function mount(setup: () => () => unknown) {
	const i18n = createI18n({ legacy: false, locale: "en", messages });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const app = createApp(defineComponent({ setup }));
	app.use(i18n);
	app.mount(host);

	return {
		text: () => host.textContent ?? "",
		setLocale: async (locale: "en" | "ja") => {
			i18n.global.locale.value = locale;
			await nextTick();
		},
		unmount: () => {
			app.unmount();
			host.remove();
		},
	};
}

describe("useLocalizedMessage", () => {
	it("re-renders a stored message in the new language", async () => {
		const view = mount(() => {
			const { t } = useI18n();
			const message = useLocalizedMessage();
			message.value = () => t("greeting");
			return () => h("p", message.value);
		});

		expect(view.text()).toBe("Hello");
		await view.setLocale("ja");
		expect(view.text()).toBe("こんにちは");
		view.unmount();
	});

	// The comparison that makes the point: the same message held the way it
	// used to be held. If this ever starts failing, `t()` has become reactive
	// on its own and the composable is no longer buying anything.
	it("is what a plain ref does not do", async () => {
		const view = mount(() => {
			const { t } = useI18n();
			const message = ref(t("greeting"));
			return () => h("p", message.value);
		});

		expect(view.text()).toBe("Hello");
		await view.setLocale("ja");
		expect(view.text()).toBe("Hello");
		view.unmount();
	});

	it("keeps the values interpolated at the time it was set", async () => {
		const view = mount(() => {
			const { t } = useI18n();
			const message = useLocalizedMessage();
			// `who` is decided when the message is produced -- an address that
			// was submitted, a count that was measured -- and must not follow
			// the field it came from afterwards.
			const who = "Ada";
			message.value = () => t("named", { who });
			return () => h("p", message.value);
		});

		expect(view.text()).toBe("Hello, Ada");
		await view.setLocale("ja");
		expect(view.text()).toBe("こんにちは、Ada");
		view.unmount();
	});

	it("takes a plain string verbatim, for text that is not translated", async () => {
		const view = mount(() => {
			const message = useLocalizedMessage();
			message.value = "mailbox already exists";
			return () => h("p", message.value);
		});

		expect(view.text()).toBe("mailbox already exists");
		await view.setLocale("ja");
		expect(view.text()).toBe("mailbox already exists");
		view.unmount();
	});

	// The templates read `v-if="message"`, so clearing has to make it falsy
	// rather than leaving an empty box behind.
	it("clears on an empty string, on null and on undefined", () => {
		for (const empty of ["", null, undefined] as const) {
			const message = useLocalizedMessage();
			message.value = () => "something";
			expect(message.value).toBe("something");
			message.value = empty;
			expect(message.value).toBe("");
		}
	});
});
