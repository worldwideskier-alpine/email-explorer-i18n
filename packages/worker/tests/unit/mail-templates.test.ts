import { describe, expect, it } from "vitest";
import {
	buildEmailChangeEmail,
	buildPasswordResetEmail,
	DEFAULT_MAIL_LOCALE,
	MAIL_LOCALES,
	resolveMailLocale,
} from "../../src/mail-templates";

const LINK = "https://mail.example.com/reset-password?token=abc-123";

describe("resolveMailLocale", () => {
	it("keeps a supported locale", () => {
		expect(resolveMailLocale("ja")).toBe("ja");
		expect(resolveMailLocale("en")).toBe("en");
		expect(resolveMailLocale("de")).toBe("de");
		expect(resolveMailLocale("ru")).toBe("ru");
		expect(resolveMailLocale("zh-Hant")).toBe("zh-Hant");
	});

	// A missing locale means an older cached dashboard or a direct API call;
	// those must keep reading the way they always have.
	it("falls back to Japanese for a missing or unknown locale", () => {
		expect(DEFAULT_MAIL_LOCALE).toBe("ja");
		expect(resolveMailLocale(undefined)).toBe("ja");
		expect(resolveMailLocale("xx")).toBe("ja");
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
		expect(buildPasswordResetEmail("ru", LINK).subject).toBe("Сброс пароля");
		expect(buildPasswordResetEmail("ko", LINK).subject).toBe(
			"비밀번호 재설정 안내",
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

		const ru = buildPasswordResetEmail("ru", LINK);
		expect(ru.html).toContain("Сбросить пароль");
		expect(ru.text).toContain("Ссылка действует один час.");
		expect(ru.html).not.toContain("パスワード");
	});

	it("tags the HTML with the matching lang attribute", () => {
		expect(buildPasswordResetEmail("en", LINK).html).toContain('<html lang="en"');
		expect(buildPasswordResetEmail("de", LINK).html).toContain('<html lang="de"');
		expect(buildPasswordResetEmail("zh-Hant", LINK).html).toContain(
			'<html lang="zh-Hant"',
		);
		expect(buildPasswordResetEmail(undefined, LINK).html).toContain(
			'<html lang="ja"',
		);
	});

	// Urdu is the one right-to-left language in the picker. The link itself
	// stays ltr so the URL does not read backwards.
	it("marks Urdu right to left and leaves everything else left to right", () => {
		const ur = buildPasswordResetEmail("ur", LINK).html;
		expect(ur).toContain('<html lang="ur" dir="rtl">');
		expect(ur).toContain(`dir="ltr">${LINK}</a>`);
		expect(buildPasswordResetEmail("ja", LINK).html).toContain(
			'<html lang="ja" dir="ltr">',
		);
	});

	// The whole point of the list: a language the picker offers must produce
	// mail in that language, not a 400 and not silent Japanese.
	it("has its own wording for every locale the picker offers", () => {
		const ja = buildPasswordResetEmail("ja", LINK);
		const untranslated = MAIL_LOCALES.filter(
			(locale) =>
				locale !== "ja" && buildPasswordResetEmail(locale, LINK).subject === ja.subject,
		);
		expect(untranslated).toEqual([]);
	});

	it("carries the reset link in every language, in both bodies", () => {
		for (const locale of [...MAIL_LOCALES, undefined]) {
			const mail = buildPasswordResetEmail(locale, LINK);
			expect(mail.html).toContain(LINK);
			expect(mail.text).toContain(LINK);
			expect(mail.subject).not.toBe("");
		}
	});

	it("still sends Japanese when no locale is given", () => {
		const mail = buildPasswordResetEmail(undefined, LINK);
		expect(mail.subject).toBe("パスワード再設定のご案内");
		expect(mail.text).toContain("このリンクの有効期限は1時間です。");
	});
});

describe("buildEmailChangeEmail", () => {
	it("writes the three languages it has", () => {
		expect(buildEmailChangeEmail("ja", LINK).subject).toBe(
			"メールアドレス変更の確認",
		);
		expect(buildEmailChangeEmail("en", LINK).subject).toBe(
			"Confirm your new email address",
		);
		expect(buildEmailChangeEmail("de", LINK).subject).toBe(
			"Neue E-Mail-Adresse bestätigen",
		);
	});

	// This table covers fewer languages than the picker. A locale it does not
	// have must read as Japanese -- never as an empty body or a crash.
	it("falls back to Japanese for a locale it does not carry yet", () => {
		for (const locale of MAIL_LOCALES) {
			const mail = buildEmailChangeEmail(locale, LINK);
			expect(mail.subject).not.toBe("");
			expect(mail.html).toContain(LINK);
			expect(mail.text).toContain(LINK);
		}
		expect(buildEmailChangeEmail("ru", LINK).subject).toBe(
			"メールアドレス変更の確認",
		);
		expect(buildEmailChangeEmail("ru", LINK).html).toContain(
			'<html lang="ja" dir="ltr">',
		);
	});
});
