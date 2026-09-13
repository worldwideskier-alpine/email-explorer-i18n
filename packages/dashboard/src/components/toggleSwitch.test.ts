import { beforeEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import ToggleSwitch from "./ToggleSwitch.vue";

/**
 * The switch shows the data, and only the data.
 *
 * The thing being ruled out, because it shipped: a `<input type=checkbox>`
 * bound with `:checked`. The browser owns that property, a click flips it
 * before any handler runs, and Vue writes a DOM property back only when the
 * *bound* value changed -- so re-reading the truth could not undo the user's
 * click, because the truth had not changed.
 *
 * Measured in a browser: on the mailbox settings screen, dismissing "unlock
 * this mailbox?" left the switch in the unlocked position beside the words
 * "Locked: cannot be deleted". The account list, with the same binding,
 * happened not to show it -- its reload swaps the list out for a loading
 * line, so the checkbox is rebuilt rather than patched. One screen wrong,
 * one screen right by accident, one binding.
 *
 * Mounted for real rather than read from the source: the fault was invisible
 * in the source (the reload was right there in the handler) and visible only
 * in a DOM -- which is also how a source-text assertion about it passed while
 * a screen was wrong.
 */

let host: HTMLElement;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
});

/** Mounts the switch over a ref, and returns the pieces to poke at. */
function mount(initial: boolean, disabled = false) {
	const on = ref(initial);
	const clicks = ref(0);
	createApp({
		setup: () => () =>
			h(ToggleSwitch, {
				on: on.value,
				disabled,
				label: "the lock",
				onToggle: () => {
					clicks.value += 1;
				},
			}),
	}).mount(host);
	return {
		on,
		clicks,
		button: host.querySelector("button") as HTMLButtonElement,
	};
}

/** Where the knob is drawn, which is what somebody actually sees. */
const knobAt = (button: HTMLButtonElement) =>
	(button.querySelector("span") as HTMLElement).className.includes(
		"start-[22px]",
	)
		? "on"
		: "off";

describe("a switch", () => {
	it("draws itself from the value it was given", async () => {
		const { on, button } = mount(true);
		expect(button.getAttribute("aria-checked")).toBe("true");
		expect(knobAt(button)).toBe("on");

		on.value = false;
		await nextTick();
		expect(button.getAttribute("aria-checked")).toBe("false");
		expect(knobAt(button)).toBe("off");
	});

	/**
	 * The whole point. A click asks; it does not decide. Until the caller
	 * comes back with a new value, what is on screen is still the old one --
	 * so a request that fails, or a question that is dismissed, leaves the
	 * switch telling the truth instead of telling the click.
	 */
	it("does not move itself when clicked", async () => {
		const { clicks, button } = mount(true);
		button.click();
		await nextTick();

		expect(clicks.value).toBe(1);
		expect(button.getAttribute("aria-checked")).toBe("true");
		expect(knobAt(button)).toBe("on");
	});

	it("still shows the value after a click the caller did not act on", async () => {
		const { on, button } = mount(true);
		button.click();
		// What a reload does: the same value arrives again.
		on.value = true;
		await nextTick();
		expect(knobAt(button)).toBe("on");
	});

	it("cannot be clicked while it is disabled", async () => {
		const { clicks, button } = mount(false, true);
		expect(button.disabled).toBe(true);
		button.click();
		await nextTick();
		expect(clicks.value).toBe(0);
	});

	it("is a switch to a screen reader, with a name", () => {
		const { button } = mount(true);
		expect(button.getAttribute("role")).toBe("switch");
		expect(button.getAttribute("aria-label")).toBe("the lock");
		// A button inside a form would submit it.
		expect(button.getAttribute("type")).toBe("button");
	});

	/**
	 * The other way to name it, and the better one where there are visible
	 * words: a `<label for>` names the control *and* clicks it, which an
	 * `aria-label` does neither of. The first attempt at making the words
	 * clickable again used `@click` on a bare `<span>`, which served a
	 * pointer and nobody else.
	 */
	it("can be named and operated by a label outside it", async () => {
		const on = ref(true);
		const clicks = ref(0);
		createApp({
			setup: () => () => [
				h("label", { for: "the-switch" }, "Deletion lock"),
				h(ToggleSwitch, {
					id: "the-switch",
					on: on.value,
					onToggle: () => {
						clicks.value += 1;
					},
				}),
			],
		}).mount(host);
		await nextTick();

		const button = host.querySelector("button") as HTMLButtonElement;
		const label = host.querySelector("label") as HTMLLabelElement;
		expect(label.control).toBe(button);
		expect(button.labels?.[0]).toBe(label);

		// One press on the words, one toggle -- not two.
		label.click();
		await nextTick();
		expect(clicks.value).toBe(1);
	});
});

describe("no screen binds a checkbox to state it does not own", () => {
	/**
	 * The fault was not in this component -- it was in the screens that each
	 * drew their own switch, and one of them is enough to bring it back. So
	 * the sweep is over every `.vue` file there is, not the two directories
	 * that happened to hold the three.
	 *
	 * What it looks for is `:checked` bound to something outside the element.
	 * `v-model` is deliberately not included: it writes `el.checked` from the
	 * model on every update rather than only when the bound value changed, so
	 * putting the model back does put the box back. Measured, not assumed --
	 * the earlier version of this test claimed more than it checked, and
	 * widening the claim to cover `v-model` would be the same mistake with a
	 * bigger net.
	 */
	it("anywhere under src", () => {
		const sources = import.meta.glob("../**/*.vue", {
			query: "?raw",
			import: "default",
			eager: true,
		}) as Record<string, string>;

		// The sweep is worthless if the glob has stopped matching anything.
		expect(Object.keys(sources).length).toBeGreaterThan(10);
		expect(Object.keys(sources)).toContain("../App.vue");
		expect(Object.keys(sources)).toContain("../views/Settings.vue");

		const offenders = Object.entries(sources)
			// This file's own comment quotes the shape it replaced.
			.filter(([path]) => !path.endsWith("/ToggleSwitch.vue"))
			.filter(([, source]) => /<input[^>]*:checked=/.test(source))
			.map(([path]) => path);
		expect(offenders).toEqual([]);
	});
});
