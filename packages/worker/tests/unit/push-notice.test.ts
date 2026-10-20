import { describe, expect, it } from "vitest";
import { DEFAULT_MAIL_LOCALE, MAIL_LOCALES } from "../../src/mail-templates";
import {
	knownLocale,
	OPEN_THE_APP,
	openTheAppNotice,
} from "../../src/push-notice";
import { isApplePush, openTheAppPayload } from "../../src/push-notify";

/**
 * What a device whose session has run out is told, in every language the
 * dashboard offers. The table is typed by MAIL_LOCALES, so one missing does
 * not compile; this holds that none is empty or left in English.
 */
describe("the 'open the app' notice", () => {
	it("has a sentence in every language the dashboard offers", () => {
		expect(Object.keys(OPEN_THE_APP).sort()).toEqual([...MAIL_LOCALES].sort());
		for (const code of MAIL_LOCALES) {
			expect(OPEN_THE_APP[code].trim(), code).not.toBe("");
			if (code !== "en") {
				expect(OPEN_THE_APP[code], code).not.toBe(OPEN_THE_APP.en);
			}
		}
	});

	it("is the device's own language when it said one the table has", () => {
		expect(openTheAppNotice("fr")).toBe(OPEN_THE_APP.fr);
		expect(openTheAppNotice("zh-Hant")).toBe(OPEN_THE_APP["zh-Hant"]);
	});

	/**
	 * Every device subscribed before devices said: in the deployment's
	 * default and in English, so a fork whose readers are not Japanese still
	 * gets a line they can read.
	 */
	it("is the default and English, one line each, when it did not", () => {
		const expected =
			DEFAULT_MAIL_LOCALE === "en"
				? OPEN_THE_APP.en
				: `${OPEN_THE_APP[DEFAULT_MAIL_LOCALE]}\n${OPEN_THE_APP.en}`;
		for (const unsaid of [null, "", "xx", "EN"]) {
			expect(openTheAppNotice(unsaid)).toBe(expected);
		}
		expect(openTheAppNotice(null, "de")).toBe(
			`${OPEN_THE_APP.de}\n${OPEN_THE_APP.en}`,
		);
	});

	/** Not the same line twice. */
	it("is English alone when English is the default", () => {
		expect(openTheAppNotice(null, "en")).toBe(OPEN_THE_APP.en);
		expect(openTheAppNotice("fr", "en")).toBe(OPEN_THE_APP.fr);
	});

	it("keeps only codes it has, and never refuses one", () => {
		expect(knownLocale("ja")).toBe("ja");
		expect(knownLocale("xx-YY")).toBeNull();
		expect(knownLocale(42)).toBeNull();
		expect(knownLocale(undefined)).toBeNull();
	});

	it("names nothing of any message", () => {
		expect(openTheAppPayload("en")).toEqual({
			title: "Email Explorer",
			body: OPEN_THE_APP.en,
			url: "/login",
			tag: "open-app",
		});
	});
});

/**
 * A dismissal is a push that shows nothing, and Safari is documented to
 * revoke the permission of a site that sends those, so none goes to any of
 * Apple's push hosts -- by host, whatever its case, and not by a name that
 * only contains Apple's.
 */
describe("Apple's push service", () => {
	it("is every push.apple.com host", () => {
		for (const host of [
			"web.push.apple.com",
			"api.push.apple.com",
			"WEB.PUSH.APPLE.COM",
		]) {
			expect(isApplePush(`https://${host}/device`), host).toBe(true);
		}
	});

	it("is not a host that only looks like one", () => {
		for (const endpoint of [
			"https://push.apple.com.example.test/device",
			"https://notpush.apple.com/device",
			"https://fcm.googleapis.com/fcm/send/device",
			"not a url",
		]) {
			expect(isApplePush(endpoint), endpoint).toBe(false);
		}
	});
});
