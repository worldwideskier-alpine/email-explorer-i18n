import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { translateApiError } from "./apiError";

/**
 * The worker answers in English, and the screen has to show the reader's
 * language.
 *
 * The keys of the `apiErrors` namespace are the worker's own sentences, which
 * is what makes them easy to match -- and one of them ends its first clause
 * with a full stop: "Registration is closed. Contact an administrator." Asked
 * for as `t("apiErrors." + key)`, vue-i18n reads the argument as a dotted
 * path, so that one was resolved as apiErrors -> "Registration is closed" ->
 * " Contact an administrator" -> "", found nothing, and fell through to the
 * raw English. In all 73 languages, with the translation sitting in every
 * catalogue the whole time, and nothing failing anywhere.
 *
 * These run against the real catalogues rather than a fixture: the defect was
 * in how a key is read, so a made-up key with a full stop in it would have
 * passed for the wrong reason while the shipped message stayed broken.
 *
 * Catalogues come from import.meta.glob rather than a direct JSON import, for
 * the reason formContrast.test.ts documents about src/ and node types.
 */

const catalogues = import.meta.glob<Record<string, Record<string, string>>>(
	"../locales/*.json",
	{ import: "default", eager: true },
);

const catalogue = (code: string) => {
	const found = catalogues[`../locales/${code}.json`];
	if (!found) throw new Error(`no catalogue for ${code}`);
	return found;
};

const ja = catalogue("ja");
const en = catalogue("en");
// German rather than English for the second language: the English catalogue
// translates each of these keys to itself, so a lookup that failed entirely
// would still come out right in English and prove nothing.
const de = catalogue("de");

beforeEach(() => {
	i18n.global.setLocaleMessage("ja", ja);
	i18n.global.setLocaleMessage("en", en);
	i18n.global.setLocaleMessage("de", de);
	i18n.global.locale.value = "ja";
});

describe("showing an API error in the reader's language", () => {
	it("translates every message the worker can send", () => {
		const messages = Object.entries(ja.apiErrors);
		expect(messages.length).toBeGreaterThan(10);
		for (const [sent, shown] of messages) {
			expect(translateApiError(sent, "unused")).toBe(shown);
		}
	});

	// The one that was broken, named, so a failure says which shape it is.
	it("reads a full stop in the message as text, not as a path", () => {
		const sent = "Registration is closed. Contact an administrator.";
		expect(ja.apiErrors[sent]).toBeTypeOf("string");
		expect(translateApiError(sent, "unused")).toBe(ja.apiErrors[sent]);
		expect(translateApiError(sent, "unused")).not.toContain("apiErrors");
	});

	it("follows the language the reader chose", () => {
		const sent = "Registration is closed. Contact an administrator.";
		i18n.global.locale.value = "de";
		expect(de.apiErrors[sent]).not.toBe(sent);
		expect(translateApiError(sent, "unused")).toBe(de.apiErrors[sent]);
	});

	it("shows a message it has no translation for as it came", () => {
		expect(translateApiError("Something nobody has translated", "x")).toBe(
			"Something nobody has translated",
		);
	});

	it("uses the caller's fallback when the worker said nothing", () => {
		const fallback = "Login failed";
		for (const nothing of [undefined, null, ""]) {
			expect(translateApiError(nothing, fallback)).toBe(ja.apiErrors[fallback]);
		}
	});
});
