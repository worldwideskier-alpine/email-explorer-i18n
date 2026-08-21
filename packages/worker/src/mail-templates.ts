/**
 * Localized bodies for the mail the Worker itself sends.
 *
 * The dashboard is translated through vue-i18n, but mail leaves the Worker
 * long after the browser is gone, so its wording lives here and is picked by
 * the locale the requesting page passes along.
 */

export const MAIL_LOCALES = ["ja", "en", "de"] as const;

export type MailLocale = (typeof MAIL_LOCALES)[number];

/**
 * Japanese, not English, is the fallback: this deployment serves a Japanese
 * mailbox and the dashboard opens in Japanese, so a request without a locale
 * (an older cached page, or a direct API call) should read the same as it
 * always has.
 */
export const DEFAULT_MAIL_LOCALE: MailLocale = "ja";

export function resolveMailLocale(locale: string | undefined): MailLocale {
	return MAIL_LOCALES.includes(locale as MailLocale)
		? (locale as MailLocale)
		: DEFAULT_MAIL_LOCALE;
}

interface PasswordResetStrings {
	subject: string;
	heading: string;
	intro: string;
	button: string;
	copyPrompt: string;
	expiry: string;
	ignore: string;
	footer: string;
	fontStack: string;
}

const PASSWORD_RESET: Record<MailLocale, PasswordResetStrings> = {
	ja: {
		subject: "パスワード再設定のご案内",
		heading: "パスワード再設定のご案内",
		intro:
			"パスワード再設定のリクエストを受け付けました。下記のボタンをクリックして手続きを進めてください。",
		button: "パスワードを再設定する",
		copyPrompt: "またはこちらのリンクをブラウザにコピー＆ペーストしてください:",
		expiry: "このリンクの有効期限は1時間です。",
		ignore:
			"心当たりがない場合は、このメールを無視していただいて問題ありません。",
		footer: "Email Explorer - パスワード再設定",
		fontStack: '"Hiragino Sans", "Yu Gothic", Arial, sans-serif',
	},
	en: {
		subject: "Reset your password",
		heading: "Reset your password",
		intro:
			"We received a request to reset your password. Click the button below to continue.",
		button: "Reset password",
		copyPrompt: "Or copy and paste this link into your browser:",
		expiry: "This link expires in one hour.",
		ignore: "If you didn't request this, you can safely ignore this email.",
		footer: "Email Explorer - Password reset",
		fontStack: "Arial, Helvetica, sans-serif",
	},
	de: {
		subject: "Passwort zurücksetzen",
		heading: "Passwort zurücksetzen",
		intro:
			"Wir haben eine Anfrage zum Zurücksetzen Ihres Passworts erhalten. Klicken Sie auf die Schaltfläche unten, um fortzufahren.",
		button: "Passwort zurücksetzen",
		copyPrompt: "Oder kopieren Sie diesen Link in Ihren Browser:",
		expiry: "Dieser Link ist eine Stunde lang gültig.",
		ignore:
			"Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.",
		footer: "Email Explorer - Passwort zurücksetzen",
		fontStack: "Arial, Helvetica, sans-serif",
	},
};

export function buildPasswordResetEmail(
	locale: string | undefined,
	resetLink: string,
): { subject: string; html: string; text: string } {
	const lang = resolveMailLocale(locale);
	const s = PASSWORD_RESET[lang];

	return {
		subject: s.subject,
		html: `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { font-family: ${s.fontStack}; line-height: 1.6; color: #333; }
		.container { max-width: 600px; margin: 0 auto; padding: 20px; }
		.header { background-color: #4F46E5; color: white; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
		.content { background-color: #f9f9f9; padding: 20px; border-radius: 5px; }
		.button { display: inline-block; padding: 12px 30px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
		.footer { margin-top: 20px; font-size: 12px; color: #666; }
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h2 style="margin: 0;">${s.heading}</h2>
		</div>
		<div class="content">
			<p>${s.intro}</p>
			<a href="${resetLink}" class="button">${s.button}</a>
			<p>${s.copyPrompt}</p>
			<p><a href="${resetLink}" style="color: #4F46E5; word-break: break-all;">${resetLink}</a></p>
			<p style="color: #666; font-size: 14px;">${s.expiry}</p>
			<p style="color: #666; font-size: 14px;">${s.ignore}</p>
		</div>
		<div class="footer">
			<p>${s.footer}</p>
		</div>
	</div>
</body>
</html>`,
		text: `${s.heading}

${s.intro}

${resetLink}

${s.expiry}

${s.ignore}`,
	};
}
