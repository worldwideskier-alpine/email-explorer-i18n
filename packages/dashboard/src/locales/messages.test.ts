import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import { LOCALES } from "./registry";

/**
 * Every message in every catalogue has to compile, and every catalogue has to
 * hold the same keys.
 *
 * vue-i18n compiles a message the first time it is asked for, not at build
 * time, so a malformed one is a runtime error inside whichever component
 * renders it -- and it takes that whole component down. An example address in
 * a placeholder ("recipient@example.com") did exactly this: "@" opens a linked
 * key in the message syntax, so the compose dialog threw on open and never
 * appeared, while the build, the type check and every other test stayed green.
 * Asking for each key is the check: compilation is what throws.
 *
 * Key parity matters more with 46 catalogues than it did with three. A key
 * added to the Japanese one and forgotten elsewhere falls back to English
 * silently, so the gap shows up as one stray English word on an otherwise
 * translated screen -- and only for the people who read that language.
 */

/** What a catalogue file holds: nested objects bottoming out in strings. */
type Catalogue = { [key: string]: string | Catalogue };

const catalogues = import.meta.glob<Catalogue>("./*.json", {
	import: "default",
	eager: true,
});

const codeOf = (path: string) =>
	(path.split("/").pop() as string).replace(/\.json$/, "");

const byCode = new Map(
	Object.entries(catalogues).map(([path, messages]) => [
		codeOf(path),
		messages,
	]),
);

/** Every leaf as its path, since a key may itself hold a full stop. */
function leafPaths(node: unknown, path: string[] = []): string[][] {
	if (typeof node === "string") return [path];
	if (node && typeof node === "object") {
		return Object.entries(node).flatMap(([key, value]) =>
			leafPaths(value, [...path, key]),
		);
	}
	return [];
}

function leafKeys(node: unknown, prefix = ""): string[] {
	if (typeof node === "string") return [prefix];
	if (node && typeof node === "object") {
		return Object.entries(node).flatMap(([key, value]) =>
			leafKeys(value, prefix ? `${prefix}.${key}` : key),
		);
	}
	return [];
}

describe("locale catalogues", () => {
	it("ships a catalogue for every language the picker offers", () => {
		const advertised = LOCALES.map((entry) => entry.code).sort();
		const present = [...byCode.keys()].sort();
		expect(present).toEqual(advertised);
	});

	it.each([...byCode.keys()])("compiles every message in %s", (code) => {
		const messages = byCode.get(code) as Catalogue;
		const i18n = createI18n({
			legacy: false,
			locale: code,
			// No fallback: a broken message must surface here rather than be
			// quietly served from another locale.
			fallbackLocale: code,
			messages: { [code]: messages },
		});
		const { t, tm, rt } = i18n.global as unknown as {
			t: (key: string) => string;
			tm: (key: string) => Record<string, unknown>;
			rt: (message: unknown) => string;
		};
		// A key holding a full stop cannot be asked for as a dotted path: `t`
		// splits it, finds nothing, warns and hands the key back, so its
		// message was never compiled here at all. It is fetched the way
		// translateApiError fetches it, by indexing its namespace.
		const render = (path: string[]) => {
			const leaf = path[path.length - 1] as string;
			if (!leaf.includes(".")) return t(path.join("."));
			return rt(tm(path.slice(0, -1).join("."))[leaf]);
		};

		const failures: string[] = [];
		for (const path of leafPaths(messages)) {
			try {
				render(path);
			} catch (e) {
				failures.push(`${path.join(" > ")}: ${(e as Error).message}`);
			}
		}

		expect(failures).toEqual([]);
	});

	it("keeps every catalogue on the same set of keys", () => {
		const reference = leafKeys(byCode.get("ja")).sort();
		expect(reference.length).toBeGreaterThan(0);

		const mismatches: string[] = [];
		for (const [code, messages] of byCode) {
			const keys = leafKeys(messages).sort();
			const missing = reference.filter((key) => !keys.includes(key));
			const extra = keys.filter((key) => !reference.includes(key));
			if (missing.length || extra.length) {
				mismatches.push(
					`${code}: ${missing.length} missing (${missing
						.slice(0, 3)
						.join(", ")}), ${extra.length} extra (${extra
						.slice(0, 3)
						.join(", ")})`,
				);
			}
		}

		expect(mismatches).toEqual([]);
	});
});
