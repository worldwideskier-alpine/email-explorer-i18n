import { describe, expect, it } from "vitest";
import root from "./Root.vue?raw";

/**
 * The "add an account" row lines its fields up.
 *
 * Measured in Chromium at 1280: the selector sat 18px above the address
 * and password fields and was 2px shorter. The row aligns its columns on
 * their bottom edge and only the selector's column carried a note under it,
 * which lifted the selector; and a select and a text field take different
 * default borders and ignore line height differently, so the same padding
 * gave them different heights. The note is on a line of its own now and the
 * four controls share one height, the same as the button's.
 */
const control = (id: string) => {
	const tag = new RegExp(
		`<(?:input|select)\\b[^>]*?id="${id}"[^>]*?>`,
		"s",
	).exec(root)?.[0];
	if (!tag) throw new Error(`no control #${id}`);
	return tag;
};

describe("the add-an-account row", () => {
	it("gives every control the same height and border", () => {
		for (const id of [
			"newRole",
			"newEmail",
			"newPassword",
			"rootCurrentPassword",
		]) {
			const classes = /class="([^"]*)"/.exec(control(id))?.[1].split(/\s+/);
			expect(classes, id).toContain("h-10");
			expect(classes, id).toContain("border");
			expect(classes, id).not.toContain("p-2");
		}
	});

	it("keeps the note under the row, not under the selector", () => {
		const form = root.slice(
			root.indexOf('@submit.prevent="createAccount"'),
			root.indexOf("</form>"),
		);
		const hint = form.indexOf("root.create.roleAdminHint");
		expect(hint).toBeGreaterThan(form.indexOf('type="submit"'));
	});
});
