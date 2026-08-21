import { describe, expect, it } from "vitest";
import {
	buildPasswordResetEmail,
	DEFAULT_MAIL_LOCALE,
	resolveMailLocale,
} from "../../src/mail-templates";

const LINK = "https://mail.example.com/reset-password?token=abc-123";

describe("resolveMailLocale", () => {
	it("keeps a supported locale", () => {
		expect(resolveMailLocale("ja")).toBe("ja");
		expect(resolveMailLocale("en")).toBe("en");
		expect(resolveMailLocale("de")).toBe("de");
	});

	// A missing locale means an older cached dashboard or a direct API call;
	// those must keep reading the way they always have.
	it("falls back to Japanese for a missing or unknown locale", () => {
		expect(DEFAULT_MAIL_LOCALE).toBe("ja");
		expect(resolveMailLocale(undefined)).toBe("ja");
		expect(resolveMailLocale("fr")).toBe("ja");
		expect(resolveMailLocale("")).toBe("ja");
	});
});

describe("buildPasswordResetEmail", () => {
	it("writes the subject in the requested language", () => {
		expect(buildPasswordResetEmail("ja", LINK).subject).toBe(
			"パスワード再設定のご案内",
		);
		expect(buildPasswordResetEmail("en", LINK).subject).toBe(
			"Reset your password",
		);
		expect(buildPasswordResetEmail("de", LINK).subject).toBe(
			"Passwort zurücksetzen",
		);
	});

	it("writes both bodies in the requested language", () => {
		const en = buildPasswordResetEmail("en", LINK);
		expect(en.html).toContain("Reset password");
		expect(en.text).toContain("This link expires in one hour.");
		expect(en.html).not.toContain("パスワード");
		expect(en.text).not.toContain("パスワード");

		const de = buildPasswordResetEmail("de", LINK);
		expect(de.html).toContain("Passwort zurücksetzen");
		expect(de.text).toContain("Dieser Link ist eine Stunde lang gültig.");
		expect(de.html).not.toContain("パスワード");
	});

	it("tags the HTML with the matching lang attribute", () => {
		expect(buildPasswordResetEmail("en", LINK).html).toContain('<html lang="en"');
		expect(buildPasswordResetEmail("de", LINK).html).toContain('<html lang="de"');
		expect(buildPasswordResetEmail(undefined, LINK).html).toContain(
			'<html lang="ja"',
		);
	});

	it("carries the reset link in every language, in both bodies", () => {
		for (const locale of ["ja", "en", "de", undefined]) {
			const mail = buildPasswordResetEmail(locale, LINK);
			expect(mail.html).toContain(LINK);
			expect(mail.text).toContain(LINK);
		}
	});

	it("still sends Japanese when no locale is given", () => {
		const mail = buildPasswordResetEmail(undefined, LINK);
		expect(mail.subject).toBe("パスワード再設定のご案内");
		expect(mail.text).toContain("このリンクの有効期限は1時間です。");
	});
});
