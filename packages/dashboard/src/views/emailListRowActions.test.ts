import { describe, expect, it } from "vitest";

/**
 * The star, read, spam and delete buttons on a row of the message list.
 *
 * From `sm` up they were `sm:hidden sm:group-hover:flex`: shown only under a
 * mouse. A hidden button cannot take focus, so a keyboard never reached them,
 * and a tablet at 640px or wider has no hover, so it never showed them either.
 *
 * Measured in Chromium against the built stylesheet at 1024px: untouched, the
 * buttons are `display: none` and the date shows; a Tab onto the row shows
 * them and hides the date, and the next Tabs land on Star and then Mark as
 * read. With the old classes the focus reached the same buttons while they
 * stayed `none`. Emulating touch (`pointer: coarse`) they show untouched, and
 * with the old classes they did not. Layout is not something vitest can see,
 * so what is held here is the arrangement that produced those numbers.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const emailList = Object.values(
	import.meta.glob("./EmailList.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

const classesOf = (marker: string): string => {
	const at = emailList.indexOf(marker);
	if (at < 0) throw new Error(`EmailList.vue: ${marker} is no longer findable`);
	const open = emailList.lastIndexOf('class="', at);
	return emailList.slice(open + 7, emailList.indexOf('"', open + 7));
};

describe("the actions on a row of the message list", () => {
	// The element that holds the buttons: the last one opened before the star.
	const holder = (() => {
		const star = emailList.indexOf('@click.prevent="toggleStarStatus(email)"');
		const div = emailList.lastIndexOf('<div class="', star);
		if (star < 0 || div < 0) {
			throw new Error(
				"EmailList.vue: the row's actions are no longer findable",
			);
		}
		return emailList.slice(div + 12, emailList.indexOf('"', div + 12));
	})();
	const date = classesOf("{{ formatListDate(email.date) }}");

	it("show under a mouse, as before", () => {
		expect(holder).toContain("sm:group-hover:flex");
		expect(date).toContain("sm:group-hover:hidden");
	});

	it("show while the row has keyboard focus", () => {
		expect(holder).toContain("sm:group-focus-within:flex");
		expect(date).toContain("sm:group-focus-within:hidden");
	});

	it("show on a screen with no hover", () => {
		expect(holder).toContain("sm:pointer-coarse:flex");
		expect(date).toContain("sm:pointer-coarse:hidden");
	});
});
