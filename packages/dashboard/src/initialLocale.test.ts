import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which language the app opens in, end to end through i18n.ts.
 *
 * browserLocale.test.ts checks the matching rules. This checks the thing that
 * decides whether reading the browser's list is safe at all: a stored choice
 * has to win over it, always. Someone who picked a language has decided, and
 * an accident of what their operating system is set to must never overrule
 * that -- otherwise a Japanese administrator on an English phone finds the
 * app in English every time they open it.
 *
 * i18n.ts reads both localStorage and navigator when the module first loads,
 * so each case needs a fresh module registry.
 */

const STORAGE_KEY = "email-explorer-locale";

async function openWith(options: {
	stored?: string | null;
	languages?: string[];
	storageThrows?: boolean;
}): Promise<string> {
	vi.resetModules();

	if (options.storageThrows) {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied, as a private window does");
		});
	} else {
		localStorage.clear();
		if (options.stored) localStorage.setItem(STORAGE_KEY, options.stored);
	}

	vi.spyOn(navigator, "languages", "get").mockReturnValue(
		options.languages ?? [],
	);

	const { i18n } = await import("./i18n");
	return i18n.global.locale.value as string;
}

describe("the language the app opens in", () => {
	beforeEach(() => {
		localStorage.clear();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	it("uses the stored choice, whatever the browser asks for", async () => {
		expect(await openWith({ stored: "ja", languages: ["en-US", "en"] })).toBe(
			"ja",
		);
		expect(await openWith({ stored: "de", languages: ["ja-JP"] })).toBe("de");
	});

	it("reads the browser only when nothing is stored", async () => {
		expect(await openWith({ languages: ["de-DE", "en"] })).toBe("de");
		expect(await openWith({ languages: ["zh-TW"] })).toBe("zh-Hant");
	});

	// The deployment's own default, which is what a first visit got before.
	it("falls back to Japanese when the browser asks for nothing it has", async () => {
		expect(await openWith({ languages: ["he-IL", "ar"] })).toBe("ja");
		expect(await openWith({ languages: [] })).toBe("ja");
	});

	// A stored value that is not a language any more must not strand anyone.
	it("ignores a stored value that is not a language it ships", async () => {
		expect(await openWith({ stored: "klingon", languages: ["ko-KR"] })).toBe(
			"ko",
		);
	});

	/**
	 * localStorage throws outright in some privacy modes rather than
	 * returning null. Failing to start is not an option, and neither is
	 * ignoring the browser in that case: a private window is exactly where
	 * nobody has a stored choice.
	 */
	it("still reads the browser when storage is unreadable", async () => {
		expect(await openWith({ storageThrows: true, languages: ["fr-FR"] })).toBe(
			"fr",
		);
	});
});
