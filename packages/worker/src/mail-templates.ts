/**
 * Localized bodies for the mail the Worker itself sends.
 *
 * The dashboard is translated through vue-i18n, but mail leaves the Worker
 * long after the browser is gone, so its wording lives here and is picked by
 * the locale the requesting page passes along.
 *
 * MAIL_LOCALES must list exactly the codes in the dashboard's
 * `locales/registry.ts`, because the dashboard sends whichever locale it is
 * displaying and the request schemas validate against this list. When the two
 * drifted apart, "forgot password" from any of the other languages was
 * rejected with a 400 and no mail went out at all -- a worse failure than
 * falling back to Japanese, and an invisible one, because the dashboard shows
 * the same reassuring "if that address has an account..." either way.
 * `mailLocales.test.ts` in the dashboard package holds the two lists together.
 */

export const MAIL_LOCALES = [
	"ja",
	"ko",
	"mn",
	"yue",
	"zh-Hans",
	"zh-Hant",

	"az",
	"be",
	"bg",
	"bs",
	"ca",
	"cnr",
	"cs",
	"da",
	"de",
	"el",
	"en",
	"es",
	"et",
	"fi",
	"fr",
	"ga",
	"hr",
	"hu",
	"hy",
	"is",
	"it",
	"ka",
	"lb",
	"lt",
	"lv",
	"mk",
	"mt",
	"nb",
	"nl",
	"nn",
	"pl",
	"pt",
	"rm",
	"ro",
	"ru",
	"sk",
	"sl",
	"sq",
	"sr",
	"sv",
	"tr",
	"uk",

	"bn",
	"gu",
	"hi",
	"kn",
	"ml",
	"mr",
	"ne",
	"or",
	"pa",
	"si",
	"ta",
	"te",
	"ur",

	"fil",
	"id",
	"km",
	"lo",
	"ms",
	"my",
	"th",
	"vi",
] as const;

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

interface LinkEmailStrings {
	subject: string;
	heading: string;
	intro: string;
	button: string;
	copyPrompt: string;
	expiry: string;
	ignore: string;
	footer: string;
}

/** Only for scripts written right to left, mirroring registry.ts. */
const RTL_LOCALES: ReadonlySet<string> = new Set<MailLocale>(["ur"]);

/**
 * Only the scripts where a Latin-first stack picks a bad face are named. Every
 * stack ends in `sans-serif`, and mail clients fall back per glyph, so Greek,
 * Cyrillic, Devanagari, Khmer and the rest render from the system font without
 * us inventing family names that may not be installed anywhere.
 */
const DEFAULT_FONT_STACK = "Arial, Helvetica, sans-serif";

const FONT_STACKS: Partial<Record<MailLocale, string>> = {
	ja: '"Hiragino Sans", "Yu Gothic", Arial, sans-serif',
	ko: '"Apple SD Gothic Neo", "Malgun Gothic", Arial, sans-serif',
	"zh-Hans": '"PingFang SC", "Microsoft YaHei", Arial, sans-serif',
	"zh-Hant": '"PingFang TC", "Microsoft JhengHei", Arial, sans-serif',
	yue: '"PingFang TC", "Microsoft JhengHei", Arial, sans-serif',
};

const PASSWORD_RESET: Record<MailLocale, LinkEmailStrings> = {
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
	},
	ko: {
		subject: "비밀번호 재설정 안내",
		heading: "비밀번호 재설정 안내",
		intro:
			"비밀번호 재설정 요청을 접수했습니다. 계속하려면 아래 버튼을 누르세요.",
		button: "비밀번호 재설정",
		copyPrompt: "또는 이 링크를 브라우저에 복사해 붙여 넣으세요:",
		expiry: "이 링크는 1시간 후에 만료됩니다.",
		ignore: "요청하지 않으셨다면 이 메일은 무시하셔도 됩니다.",
		footer: "Email Explorer - 비밀번호 재설정",
	},
	mn: {
		subject: "Нууц үг сэргээх заавар",
		heading: "Нууц үг сэргээх заавар",
		intro:
			"Таны нууц үгийг сэргээх хүсэлтийг хүлээн авлаа. Үргэлжлүүлэхийн тулд доорх товчийг дарна уу.",
		button: "Нууц үг сэргээх",
		copyPrompt: "Эсвэл энэ холбоосыг хөтөч рүүгээ хуулж тавина уу:",
		expiry: "Энэ холбоос нэг цагийн дараа хүчингүй болно.",
		ignore:
			"Хэрэв та ийм хүсэлт илгээгээгүй бол энэ захидлыг үл тоомсорлож болно.",
		footer: "Email Explorer - Нууц үг сэргээх",
	},
	yue: {
		subject: "重設密碼指引",
		heading: "重設密碼指引",
		intro: "我哋收到重設你密碼嘅要求。㩒下面嘅掣就可以繼續。",
		button: "重設密碼",
		copyPrompt: "或者將呢條連結複製貼上瀏覽器：",
		expiry: "呢條連結一個鐘之後就會失效。",
		ignore: "如果唔係你要求嘅，唔理呢封電郵就得。",
		footer: "Email Explorer - 重設密碼",
	},
	"zh-Hans": {
		subject: "重置密码",
		heading: "重置密码",
		intro: "我们收到了重置您密码的请求。请点击下面的按钮继续。",
		button: "重置密码",
		copyPrompt: "或者将此链接复制粘贴到浏览器中：",
		expiry: "此链接一小时后失效。",
		ignore: "如果这不是您本人的操作，忽略这封邮件即可。",
		footer: "Email Explorer - 重置密码",
	},
	"zh-Hant": {
		subject: "重設密碼",
		heading: "重設密碼",
		intro: "我們收到了重設您密碼的請求。請點擊下面的按鈕繼續。",
		button: "重設密碼",
		copyPrompt: "或將此連結複製貼上至瀏覽器：",
		expiry: "此連結將於一小時後失效。",
		ignore: "若這不是您本人的操作，忽略這封郵件即可。",
		footer: "Email Explorer - 重設密碼",
	},

	az: {
		subject: "Parolun sıfırlanması",
		heading: "Parolun sıfırlanması",
		intro:
			"Parolunuzu sıfırlamaq üçün sorğu aldıq. Davam etmək üçün aşağıdakı düyməni klikləyin.",
		button: "Parolu sıfırla",
		copyPrompt: "Və ya bu keçidi brauzerinizə kopyalayıb yapışdırın:",
		expiry: "Bu keçid bir saatdan sonra qüvvədən düşür.",
		ignore:
			"Əgər bunu siz tələb etməmisinizsə, bu məktubu nəzərə almaya bilərsiniz.",
		footer: "Email Explorer - Parolun sıfırlanması",
	},
	be: {
		subject: "Аднаўленне пароля",
		heading: "Аднаўленне пароля",
		intro:
			"Мы атрымалі запыт на аднаўленне вашага пароля. Націсніце кнопку ніжэй, каб працягнуць.",
		button: "Аднавіць пароль",
		copyPrompt: "Або скапіруйце гэтую спасылку ў свой браўзер:",
		expiry: "Спасылка дзейнічае адну гадзіну.",
		ignore: "Калі вы гэтага не запытвалі, проста праігнаруйце гэты ліст.",
		footer: "Email Explorer - Аднаўленне пароля",
	},
	bg: {
		subject: "Възстановяване на паролата",
		heading: "Възстановяване на паролата",
		intro:
			"Получихме заявка за възстановяване на паролата ви. Натиснете бутона по-долу, за да продължите.",
		button: "Възстановяване на паролата",
		copyPrompt: "Или копирайте тази връзка в браузъра си:",
		expiry: "Връзката е валидна един час.",
		ignore:
			"Ако не сте заявявали това, можете спокойно да пренебрегнете писмото.",
		footer: "Email Explorer - Възстановяване на паролата",
	},
	bs: {
		subject: "Ponovno postavljanje lozinke",
		heading: "Ponovno postavljanje lozinke",
		intro:
			"Primili smo zahtjev za ponovno postavljanje vaše lozinke. Kliknite na dugme ispod da nastavite.",
		button: "Postavi novu lozinku",
		copyPrompt: "Ili kopirajte ovaj link u svoj preglednik:",
		expiry: "Ovaj link vrijedi jedan sat.",
		ignore: "Ako ovo niste tražili, slobodno zanemarite ovu poruku.",
		footer: "Email Explorer - Ponovno postavljanje lozinke",
	},
	ca: {
		subject: "Restabliment de la contrasenya",
		heading: "Restabliment de la contrasenya",
		intro:
			"Hem rebut una sol·licitud per restablir la vostra contrasenya. Feu clic al botó de sota per continuar.",
		button: "Restablir la contrasenya",
		copyPrompt: "O copieu i enganxeu aquest enllaç al navegador:",
		expiry: "Aquest enllaç caduca en una hora.",
		ignore: "Si no ho heu demanat vós, podeu ignorar aquest missatge.",
		footer: "Email Explorer - Restabliment de la contrasenya",
	},
	cnr: {
		subject: "Postavljanje nove lozinke",
		heading: "Postavljanje nove lozinke",
		intro:
			"Primili smo zahtjev da postavite novu lozinku. Kliknite na dugme ispod da nastavite.",
		button: "Postavi novu lozinku",
		copyPrompt: "Ili kopirajte ovaj link u svoj pregledač:",
		expiry: "Ovaj link važi jedan sat.",
		ignore: "Ako ovo niste tražili, slobodno zanemarite ovu poruku.",
		footer: "Email Explorer - Nova lozinka",
	},
	cs: {
		subject: "Obnovení hesla",
		heading: "Obnovení hesla",
		intro:
			"Obdrželi jsme žádost o obnovení vašeho hesla. Pokračujte kliknutím na tlačítko níže.",
		button: "Obnovit heslo",
		copyPrompt: "Nebo tento odkaz zkopírujte do prohlížeče:",
		expiry: "Platnost odkazu vyprší za hodinu.",
		ignore: "Pokud jste o to nežádali, můžete tento e-mail ignorovat.",
		footer: "Email Explorer - Obnovení hesla",
	},
	da: {
		subject: "Nulstil din adgangskode",
		heading: "Nulstil din adgangskode",
		intro:
			"Vi har modtaget en anmodning om at nulstille din adgangskode. Klik på knappen nedenfor for at fortsætte.",
		button: "Nulstil adgangskode",
		copyPrompt: "Eller kopier dette link ind i din browser:",
		expiry: "Linket udløber om en time.",
		ignore:
			"Hvis du ikke har bedt om dette, kan du roligt ignorere denne mail.",
		footer: "Email Explorer - Nulstilling af adgangskode",
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
	},
	el: {
		subject: "Επαναφορά κωδικού πρόσβασης",
		heading: "Επαναφορά κωδικού πρόσβασης",
		intro:
			"Λάβαμε αίτημα για επαναφορά του κωδικού πρόσβασής σας. Κάντε κλικ στο παρακάτω κουμπί για να συνεχίσετε.",
		button: "Επαναφορά κωδικού",
		copyPrompt: "Ή αντιγράψτε αυτόν τον σύνδεσμο στο πρόγραμμα περιήγησής σας:",
		expiry: "Ο σύνδεσμος λήγει σε μία ώρα.",
		ignore: "Αν δεν το ζητήσατε εσείς, αγνοήστε αυτό το μήνυμα.",
		footer: "Email Explorer - Επαναφορά κωδικού",
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
	},
	es: {
		subject: "Restablecer la contraseña",
		heading: "Restablecer la contraseña",
		intro:
			"Hemos recibido una solicitud para restablecer tu contraseña. Haz clic en el botón de abajo para continuar.",
		button: "Restablecer contraseña",
		copyPrompt: "O copia y pega este enlace en tu navegador:",
		expiry: "Este enlace caduca en una hora.",
		ignore: "Si no lo has solicitado, puedes ignorar este mensaje.",
		footer: "Email Explorer - Restablecer contraseña",
	},
	et: {
		subject: "Parooli lähtestamine",
		heading: "Parooli lähtestamine",
		intro:
			"Saime taotluse teie parooli lähtestamiseks. Jätkamiseks klõpsake allolevat nuppu.",
		button: "Lähtesta parool",
		copyPrompt: "Või kopeerige see link oma brauserisse:",
		expiry: "Link aegub ühe tunni pärast.",
		ignore: "Kui te seda ei taotlenud, võite selle kirja tähelepanuta jätta.",
		footer: "Email Explorer - Parooli lähtestamine",
	},
	fi: {
		subject: "Salasanan palautus",
		heading: "Salasanan palautus",
		intro:
			"Saimme pyynnön salasanasi palauttamisesta. Jatka napsauttamalla alla olevaa painiketta.",
		button: "Palauta salasana",
		copyPrompt: "Tai kopioi tämä linkki selaimeesi:",
		expiry: "Linkki vanhenee tunnin kuluttua.",
		ignore: "Jos et pyytänyt tätä, voit jättää viestin huomiotta.",
		footer: "Email Explorer - Salasanan palautus",
	},
	fr: {
		subject: "Réinitialisation de votre mot de passe",
		heading: "Réinitialisation de votre mot de passe",
		intro:
			"Nous avons reçu une demande de réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour continuer.",
		button: "Réinitialiser le mot de passe",
		copyPrompt: "Ou copiez ce lien dans votre navigateur :",
		expiry: "Ce lien expire dans une heure.",
		ignore:
			"Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.",
		footer: "Email Explorer - Réinitialisation du mot de passe",
	},
	ga: {
		subject: "Athshocrú do phasfhocail",
		heading: "Athshocrú do phasfhocail",
		intro:
			"Fuaireamar iarratas ar do phasfhocal a athshocrú. Cliceáil an cnaipe thíos chun leanúint ar aghaidh.",
		button: "Athshocraigh an pasfhocal",
		copyPrompt: "Nó cóipeáil an nasc seo isteach i do bhrabhsálaí:",
		expiry: "Rachaidh an nasc seo in éag i gceann uair an chloig.",
		ignore:
			"Mura ndearna tú an t-iarratas seo, is féidir leat neamhaird a dhéanamh den ríomhphost seo.",
		footer: "Email Explorer - Athshocrú pasfhocail",
	},
	hr: {
		subject: "Ponovno postavljanje lozinke",
		heading: "Ponovno postavljanje lozinke",
		intro:
			"Primili smo zahtjev za ponovno postavljanje vaše lozinke. Za nastavak kliknite gumb u nastavku.",
		button: "Postavi novu lozinku",
		copyPrompt: "Ili kopirajte ovu poveznicu u svoj preglednik:",
		expiry: "Poveznica vrijedi jedan sat.",
		ignore: "Ako to niste zatražili, slobodno zanemarite ovu poruku.",
		footer: "Email Explorer - Ponovno postavljanje lozinke",
	},
	hu: {
		subject: "Jelszó visszaállítása",
		heading: "Jelszó visszaállítása",
		intro:
			"Kérelmet kaptunk a jelszava visszaállítására. A folytatáshoz kattintson az alábbi gombra.",
		button: "Jelszó visszaállítása",
		copyPrompt: "Vagy másolja be ezt a hivatkozást a böngészőjébe:",
		expiry: "A hivatkozás egy óra múlva lejár.",
		ignore: "Ha nem Ön kérte, nyugodtan hagyja figyelmen kívül ezt a levelet.",
		footer: "Email Explorer - Jelszó visszaállítása",
	},
	hy: {
		subject: "Գաղտնաբառի վերականգնում",
		heading: "Գաղտնաբառի վերականգնում",
		intro:
			"Ստացել ենք ձեր գաղտնաբառը վերականգնելու հայտ։ Շարունակելու համար սեղմեք ներքևի կոճակը։",
		button: "Վերականգնել գաղտնաբառը",
		copyPrompt: "Կամ պատճենեք այս հղումը ձեր դիտարկիչում՝",
		expiry: "Հղումը վավեր է մեկ ժամ։",
		ignore: "Եթե դուք դա չեք խնդրել, կարող եք անտեսել այս նամակը։",
		footer: "Email Explorer - Գաղտնաբառի վերականգնում",
	},
	is: {
		subject: "Endurstilling lykilorðs",
		heading: "Endurstilling lykilorðs",
		intro:
			"Við fengum beiðni um að endurstilla lykilorðið þitt. Smelltu á hnappinn hér að neðan til að halda áfram.",
		button: "Endurstilla lykilorð",
		copyPrompt: "Eða afritaðu þennan tengil í vafrann þinn:",
		expiry: "Tengillinn gildir í eina klukkustund.",
		ignore: "Ef þú baðst ekki um þetta máttu hunsa þennan póst.",
		footer: "Email Explorer - Endurstilling lykilorðs",
	},
	it: {
		subject: "Reimposta la password",
		heading: "Reimposta la password",
		intro:
			"Abbiamo ricevuto una richiesta di reimpostazione della password. Fai clic sul pulsante qui sotto per continuare.",
		button: "Reimposta la password",
		copyPrompt: "Oppure copia questo link nel tuo browser:",
		expiry: "Il link scade tra un'ora.",
		ignore:
			"Se non hai richiesto tu questa operazione, puoi ignorare il messaggio.",
		footer: "Email Explorer - Reimpostazione password",
	},
	ka: {
		subject: "პაროლის აღდგენა",
		heading: "პაროლის აღდგენა",
		intro:
			"მივიღეთ თქვენი პაროლის აღდგენის მოთხოვნა. გასაგრძელებლად დააჭირეთ ქვემოთ მოცემულ ღილაკს.",
		button: "პაროლის აღდგენა",
		copyPrompt: "ან დააკოპირეთ ეს ბმული ბრაუზერში:",
		expiry: "ბმული ერთი საათის განმავლობაში მოქმედებს.",
		ignore: "თუ ეს თქვენ არ მოგითხოვიათ, უბრალოდ უგულებელყავით ეს წერილი.",
		footer: "Email Explorer - პაროლის აღდგენა",
	},
	lb: {
		subject: "Passwuert zerécksetzen",
		heading: "Passwuert zerécksetzen",
		intro:
			"Mir hunn eng Ufro kritt, Äert Passwuert zerécksetzen. Klickt op de Knäppchen hei ënnen, fir weiderzefueren.",
		button: "Passwuert zerécksetzen",
		copyPrompt: "Oder kopéiert dëse Link an Äre Browser:",
		expiry: "Dëse Link ass eng Stonn laang gëlteg.",
		ignore: "Wann Dir dat net ugefrot hutt, kënnt Dir dës E-Mail ignoréieren.",
		footer: "Email Explorer - Passwuert zerécksetzen",
	},
	lt: {
		subject: "Slaptažodžio atkūrimas",
		heading: "Slaptažodžio atkūrimas",
		intro:
			"Gavome prašymą atkurti jūsų slaptažodį. Norėdami tęsti, spustelėkite žemiau esantį mygtuką.",
		button: "Atkurti slaptažodį",
		copyPrompt: "Arba nukopijuokite šią nuorodą į naršyklę:",
		expiry: "Nuoroda galioja vieną valandą.",
		ignore: "Jei to neprašėte, šį laišką galite ignoruoti.",
		footer: "Email Explorer - Slaptažodžio atkūrimas",
	},
	lv: {
		subject: "Paroles atjaunošana",
		heading: "Paroles atjaunošana",
		intro:
			"Saņēmām pieprasījumu atjaunot jūsu paroli. Lai turpinātu, noklikšķiniet uz zemāk esošās pogas.",
		button: "Atjaunot paroli",
		copyPrompt: "Vai nokopējiet šo saiti savā pārlūkprogrammā:",
		expiry: "Saite ir derīga vienu stundu.",
		ignore: "Ja jūs to nepieprasījāt, varat šo vēstuli ignorēt.",
		footer: "Email Explorer - Paroles atjaunošana",
	},
	mk: {
		subject: "Ресетирање на лозинката",
		heading: "Ресетирање на лозинката",
		intro:
			"Примивме барање за ресетирање на вашата лозинка. Кликнете на копчето подолу за да продолжите.",
		button: "Ресетирај ја лозинката",
		copyPrompt: "Или копирајте ја оваа врска во вашиот прелистувач:",
		expiry: "Врската важи еден час.",
		ignore:
			"Ако тоа не сте го побарале вие, слободно занемарете ја оваа порака.",
		footer: "Email Explorer - Ресетирање на лозинката",
	},
	mt: {
		subject: "Irrisettja l-password tiegħek",
		heading: "Irrisettja l-password tiegħek",
		intro:
			"Irċevejna talba biex nirrisettjaw il-password tiegħek. Agħfas il-buttuna hawn taħt biex tkompli.",
		button: "Irrisettja l-password",
		copyPrompt: "Jew ikkopja din il-link fil-browser tiegħek:",
		expiry: "Din il-link tiskadi f'siegħa.",
		ignore: "Jekk ma tlabtx dan, tista' tinjora din l-email.",
		footer: "Email Explorer - Irrisettjar tal-password",
	},
	nb: {
		subject: "Tilbakestill passordet ditt",
		heading: "Tilbakestill passordet ditt",
		intro:
			"Vi har mottatt en forespørsel om å tilbakestille passordet ditt. Klikk på knappen nedenfor for å fortsette.",
		button: "Tilbakestill passord",
		copyPrompt: "Eller kopier denne lenken inn i nettleseren din:",
		expiry: "Lenken utløper om én time.",
		ignore:
			"Hvis du ikke har bedt om dette, kan du se bort fra denne e-posten.",
		footer: "Email Explorer - Tilbakestilling av passord",
	},
	nl: {
		subject: "Je wachtwoord opnieuw instellen",
		heading: "Je wachtwoord opnieuw instellen",
		intro:
			"We hebben een verzoek ontvangen om je wachtwoord opnieuw in te stellen. Klik op de knop hieronder om verder te gaan.",
		button: "Wachtwoord opnieuw instellen",
		copyPrompt: "Of kopieer deze link naar je browser:",
		expiry: "Deze link verloopt over een uur.",
		ignore: "Heb je dit niet aangevraagd, dan kun je deze e-mail negeren.",
		footer: "Email Explorer - Wachtwoord opnieuw instellen",
	},
	nn: {
		subject: "Tilbakestill passordet ditt",
		heading: "Tilbakestill passordet ditt",
		intro:
			"Vi har fått ein førespurnad om å tilbakestille passordet ditt. Klikk på knappen nedanfor for å halde fram.",
		button: "Tilbakestill passord",
		copyPrompt: "Eller kopier denne lenkja inn i nettlesaren din:",
		expiry: "Lenkja går ut om éin time.",
		ignore: "Har du ikkje bede om dette, kan du sjå bort frå denne e-posten.",
		footer: "Email Explorer - Tilbakestilling av passord",
	},
	pl: {
		subject: "Resetowanie hasła",
		heading: "Resetowanie hasła",
		intro:
			"Otrzymaliśmy prośbę o zresetowanie Twojego hasła. Kliknij poniższy przycisk, aby kontynuować.",
		button: "Zresetuj hasło",
		copyPrompt: "Albo skopiuj ten odnośnik do przeglądarki:",
		expiry: "Odnośnik wygasa po godzinie.",
		ignore: "Jeśli to nie było Twoje żądanie, zignoruj tę wiadomość.",
		footer: "Email Explorer - Resetowanie hasła",
	},
	pt: {
		subject: "Redefinir a sua palavra-passe",
		heading: "Redefinir a sua palavra-passe",
		intro:
			"Recebemos um pedido para redefinir a sua palavra-passe. Clique no botão abaixo para continuar.",
		button: "Redefinir palavra-passe",
		copyPrompt: "Ou copie esta ligação para o seu navegador:",
		expiry: "Esta ligação expira dentro de uma hora.",
		ignore: "Se não foi você que fez este pedido, pode ignorar esta mensagem.",
		footer: "Email Explorer - Redefinição de palavra-passe",
	},
	rm: {
		subject: "Reinizialisar tes pled-clav",
		heading: "Reinizialisar tes pled-clav",
		intro:
			"Nus avain retschavì ina dumonda per reinizialisar tes pled-clav. Clicca sin il buttun sutvart per cuntinuar.",
		button: "Reinizialisar il pled-clav",
		copyPrompt: "U copiescha quest link en tes browser:",
		expiry: "Quest link scada en ina ura.",
		ignore: "Sche ti n'has betg dumandà quai, pos ti ignorar questa e-mail.",
		footer: "Email Explorer - Reinizialisaziun dal pled-clav",
	},
	ro: {
		subject: "Resetarea parolei",
		heading: "Resetarea parolei",
		intro:
			"Am primit o solicitare de resetare a parolei dumneavoastră. Faceți clic pe butonul de mai jos pentru a continua.",
		button: "Resetează parola",
		copyPrompt: "Sau copiați acest link în browserul dumneavoastră:",
		expiry: "Linkul expiră într-o oră.",
		ignore:
			"Dacă nu dumneavoastră ați solicitat acest lucru, puteți ignora acest mesaj.",
		footer: "Email Explorer - Resetarea parolei",
	},
	ru: {
		subject: "Сброс пароля",
		heading: "Сброс пароля",
		intro:
			"Мы получили запрос на сброс вашего пароля. Нажмите кнопку ниже, чтобы продолжить.",
		button: "Сбросить пароль",
		copyPrompt: "Или скопируйте эту ссылку в свой браузер:",
		expiry: "Ссылка действует один час.",
		ignore: "Если вы этого не запрашивали, просто проигнорируйте это письмо.",
		footer: "Email Explorer - Сброс пароля",
	},
	sk: {
		subject: "Obnovenie hesla",
		heading: "Obnovenie hesla",
		intro:
			"Dostali sme žiadosť o obnovenie vášho hesla. Pokračujte kliknutím na tlačidlo nižšie.",
		button: "Obnoviť heslo",
		copyPrompt: "Alebo skopírujte tento odkaz do prehliadača:",
		expiry: "Platnosť odkazu vyprší o hodinu.",
		ignore: "Ak ste o to nežiadali, môžete tento e-mail ignorovať.",
		footer: "Email Explorer - Obnovenie hesla",
	},
	sl: {
		subject: "Ponastavitev gesla",
		heading: "Ponastavitev gesla",
		intro:
			"Prejeli smo zahtevo za ponastavitev vašega gesla. Za nadaljevanje kliknite spodnji gumb.",
		button: "Ponastavi geslo",
		copyPrompt: "Ali pa to povezavo kopirajte v brskalnik:",
		expiry: "Povezava velja eno uro.",
		ignore: "Če tega niste zahtevali, lahko to sporočilo prezrete.",
		footer: "Email Explorer - Ponastavitev gesla",
	},
	sq: {
		subject: "Rivendosja e fjalëkalimit",
		heading: "Rivendosja e fjalëkalimit",
		intro:
			"Morëm një kërkesë për të rivendosur fjalëkalimin tuaj. Klikoni butonin më poshtë për të vazhduar.",
		button: "Rivendos fjalëkalimin",
		copyPrompt: "Ose kopjojeni këtë lidhje në shfletuesin tuaj:",
		expiry: "Kjo lidhje skadon pas një ore.",
		ignore: "Nëse nuk e keni kërkuar ju, mund ta shpërfillni këtë mesazh.",
		footer: "Email Explorer - Rivendosja e fjalëkalimit",
	},
	sr: {
		subject: "Ресетовање лозинке",
		heading: "Ресетовање лозинке",
		intro:
			"Примили смо захтев за ресетовање ваше лозинке. Кликните на дугме испод да наставите.",
		button: "Ресетуј лозинку",
		copyPrompt: "Или копирајте ову везу у свој прегледач:",
		expiry: "Веза важи један сат.",
		ignore: "Ако то нисте тражили, слободно занемарите ову поруку.",
		footer: "Email Explorer - Ресетовање лозинке",
	},
	sv: {
		subject: "Återställ ditt lösenord",
		heading: "Återställ ditt lösenord",
		intro:
			"Vi har tagit emot en begäran om att återställa ditt lösenord. Klicka på knappen nedan för att fortsätta.",
		button: "Återställ lösenord",
		copyPrompt: "Eller kopiera den här länken till din webbläsare:",
		expiry: "Länken går ut om en timme.",
		ignore:
			"Om du inte har begärt detta kan du bortse från det här meddelandet.",
		footer: "Email Explorer - Återställning av lösenord",
	},
	tr: {
		subject: "Parolanızı sıfırlayın",
		heading: "Parolanızı sıfırlayın",
		intro:
			"Parolanızı sıfırlama isteği aldık. Devam etmek için aşağıdaki düğmeye tıklayın.",
		button: "Parolayı sıfırla",
		copyPrompt: "Ya da bu bağlantıyı tarayıcınıza kopyalayın:",
		expiry: "Bu bağlantı bir saat sonra geçersiz olur.",
		ignore: "Bunu siz istemediyseniz bu e-postayı yok sayabilirsiniz.",
		footer: "Email Explorer - Parola sıfırlama",
	},
	uk: {
		subject: "Скидання пароля",
		heading: "Скидання пароля",
		intro:
			"Ми отримали запит на скидання вашого пароля. Натисніть кнопку нижче, щоб продовжити.",
		button: "Скинути пароль",
		copyPrompt: "Або скопіюйте це посилання у свій браузер:",
		expiry: "Посилання дійсне одну годину.",
		ignore: "Якщо ви цього не запитували, просто проігноруйте цей лист.",
		footer: "Email Explorer - Скидання пароля",
	},

	bn: {
		subject: "পাসওয়ার্ড রিসেট করুন",
		heading: "পাসওয়ার্ড রিসেট করুন",
		intro:
			"আপনার পাসওয়ার্ড রিসেট করার অনুরোধ আমরা পেয়েছি। এগিয়ে যেতে নিচের বোতামে ক্লিক করুন।",
		button: "পাসওয়ার্ড রিসেট করুন",
		copyPrompt: "অথবা এই লিঙ্কটি আপনার ব্রাউজারে কপি করে বসান:",
		expiry: "এই লিঙ্কের মেয়াদ এক ঘণ্টা পরে শেষ হবে।",
		ignore: "আপনি যদি এটি না চেয়ে থাকেন, এই ইমেলটি উপেক্ষা করতে পারেন।",
		footer: "Email Explorer - পাসওয়ার্ড রিসেট",
	},
	gu: {
		subject: "પાસવર્ડ ફરીથી સેટ કરો",
		heading: "પાસવર્ડ ફરીથી સેટ કરો",
		intro:
			"તમારો પાસવર્ડ ફરીથી સેટ કરવાની વિનંતી અમને મળી છે. આગળ વધવા માટે નીચેના બટન પર ક્લિક કરો.",
		button: "પાસવર્ડ ફરીથી સેટ કરો",
		copyPrompt: "અથવા આ લિંક તમારા બ્રાઉઝરમાં કૉપિ કરીને પેસ્ટ કરો:",
		expiry: "આ લિંક એક કલાક પછી સમાપ્ત થાય છે.",
		ignore: "જો તમે આ વિનંતી કરી ન હોય, તો આ ઇમેઇલને અવગણી શકો છો.",
		footer: "Email Explorer - પાસવર્ડ ફરીથી સેટ કરવો",
	},
	hi: {
		subject: "पासवर्ड रीसेट करें",
		heading: "पासवर्ड रीसेट करें",
		intro:
			"हमें आपका पासवर्ड रीसेट करने का अनुरोध मिला है। जारी रखने के लिए नीचे दिए गए बटन पर क्लिक करें।",
		button: "पासवर्ड रीसेट करें",
		copyPrompt: "या इस लिंक को अपने ब्राउज़र में कॉपी करके चिपकाएँ:",
		expiry: "यह लिंक एक घंटे बाद समाप्त हो जाएगा।",
		ignore: "अगर आपने यह अनुरोध नहीं किया है, तो इस ईमेल को अनदेखा कर सकते हैं।",
		footer: "Email Explorer - पासवर्ड रीसेट",
	},
	kn: {
		subject: "ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸಿ",
		heading: "ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸಿ",
		intro: "ನಿಮ್ಮ ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸುವ ವಿನಂತಿ ನಮಗೆ ಬಂದಿದೆ. ಮುಂದುವರಿಯಲು ಕೆಳಗಿನ ಬಟನ್ ಒತ್ತಿರಿ.",
		button: "ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸಿ",
		copyPrompt: "ಅಥವಾ ಈ ಲಿಂಕ್ ಅನ್ನು ನಿಮ್ಮ ಬ್ರೌಸರ್‌ಗೆ ನಕಲಿಸಿ:",
		expiry: "ಈ ಲಿಂಕ್ ಒಂದು ಗಂಟೆಯ ನಂತರ ಅವಧಿ ಮೀರುತ್ತದೆ.",
		ignore: "ನೀವು ಇದನ್ನು ಕೇಳಿಲ್ಲದಿದ್ದರೆ, ಈ ಇಮೇಲ್ ಅನ್ನು ನಿರ್ಲಕ್ಷಿಸಬಹುದು.",
		footer: "Email Explorer - ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಕೆ",
	},
	ml: {
		subject: "പാസ്‌വേഡ് പുനഃസജ്ജമാക്കുക",
		heading: "പാസ്‌വേഡ് പുനഃസജ്ജമാക്കുക",
		intro:
			"നിങ്ങളുടെ പാസ്‌വേഡ് പുനഃസജ്ജമാക്കാനുള്ള അഭ്യർത്ഥന ഞങ്ങൾക്ക് ലഭിച്ചു. തുടരാൻ താഴെയുള്ള ബട്ടൺ ക്ലിക്ക് ചെയ്യുക.",
		button: "പാസ്‌വേഡ് പുനഃസജ്ജമാക്കുക",
		copyPrompt: "അല്ലെങ്കിൽ ഈ ലിങ്ക് നിങ്ങളുടെ ബ്രൗസറിൽ പകർത്തി ഒട്ടിക്കുക:",
		expiry: "ഈ ലിങ്ക് ഒരു മണിക്കൂറിനുശേഷം കാലഹരണപ്പെടും.",
		ignore: "നിങ്ങൾ ഇത് അഭ്യർത്ഥിച്ചിട്ടില്ലെങ്കിൽ, ഈ ഇമെയിൽ അവഗണിക്കാം.",
		footer: "Email Explorer - പാസ്‌വേഡ് പുനഃസജ്ജീകരണം",
	},
	mr: {
		subject: "पासवर्ड रीसेट करा",
		heading: "पासवर्ड रीसेट करा",
		intro:
			"तुमचा पासवर्ड रीसेट करण्याची विनंती आम्हाला मिळाली आहे. पुढे जाण्यासाठी खालील बटणावर क्लिक करा.",
		button: "पासवर्ड रीसेट करा",
		copyPrompt: "किंवा ही लिंक तुमच्या ब्राउझरमध्ये कॉपी करून पेस्ट करा:",
		expiry: "ही लिंक एका तासानंतर कालबाह्य होईल.",
		ignore: "तुम्ही ही विनंती केली नसेल, तर हा ईमेल दुर्लक्षित करू शकता.",
		footer: "Email Explorer - पासवर्ड रीसेट",
	},
	ne: {
		subject: "पासवर्ड रिसेट गर्नुहोस्",
		heading: "पासवर्ड रिसेट गर्नुहोस्",
		intro:
			"तपाईंको पासवर्ड रिसेट गर्ने अनुरोध हामीले पायौं। अगाडि बढ्न तलको बटनमा क्लिक गर्नुहोस्।",
		button: "पासवर्ड रिसेट गर्नुहोस्",
		copyPrompt: "वा यो लिङ्क आफ्नो ब्राउजरमा कपी गरेर टाँस्नुहोस्:",
		expiry: "यो लिङ्कको म्याद एक घण्टापछि सकिन्छ।",
		ignore: "तपाईंले यो अनुरोध गर्नुभएको छैन भने यो इमेललाई बेवास्ता गर्न सक्नुहुन्छ।",
		footer: "Email Explorer - पासवर्ड रिसेट",
	},
	or: {
		subject: "ପାସୱାର୍ଡ ରିସେଟ୍ କରନ୍ତୁ",
		heading: "ପାସୱାର୍ଡ ରିସେଟ୍ କରନ୍ତୁ",
		intro:
			"ଆପଣଙ୍କ ପାସୱାର୍ଡ ରିସେଟ୍ କରିବାର ଅନୁରୋଧ ଆମେ ପାଇଛୁ। ଆଗକୁ ବଢ଼ିବା ପାଇଁ ତଳ ବଟନ୍ ଉପରେ କ୍ଲିକ୍ କରନ୍ତୁ।",
		button: "ପାସୱାର୍ଡ ରିସେଟ୍ କରନ୍ତୁ",
		copyPrompt: "କିମ୍ବା ଏହି ଲିଙ୍କକୁ ଆପଣଙ୍କ ବ୍ରାଉଜରରେ କପି କରି ପେଷ୍ଟ କରନ୍ତୁ:",
		expiry: "ଏହି ଲିଙ୍କ ଏକ ଘଣ୍ଟା ପରେ ଅବୈଧ ହୋଇଯିବ।",
		ignore: "ଯଦି ଆପଣ ଏହା ଅନୁରୋଧ କରିନାହାଁନ୍ତି, ଏହି ଇମେଲକୁ ଅଣଦେଖା କରିପାରିବେ।",
		footer: "Email Explorer - ପାସୱାର୍ଡ ରିସେଟ୍",
	},
	pa: {
		subject: "ਪਾਸਵਰਡ ਰੀਸੈੱਟ ਕਰੋ",
		heading: "ਪਾਸਵਰਡ ਰੀਸੈੱਟ ਕਰੋ",
		intro:
			"ਸਾਨੂੰ ਤੁਹਾਡਾ ਪਾਸਵਰਡ ਰੀਸੈੱਟ ਕਰਨ ਦੀ ਬੇਨਤੀ ਮਿਲੀ ਹੈ। ਅੱਗੇ ਵਧਣ ਲਈ ਹੇਠਾਂ ਦਿੱਤੇ ਬਟਨ 'ਤੇ ਕਲਿੱਕ ਕਰੋ।",
		button: "ਪਾਸਵਰਡ ਰੀਸੈੱਟ ਕਰੋ",
		copyPrompt: "ਜਾਂ ਇਹ ਲਿੰਕ ਆਪਣੇ ਬ੍ਰਾਊਜ਼ਰ ਵਿੱਚ ਕਾਪੀ ਕਰਕੇ ਪੇਸਟ ਕਰੋ:",
		expiry: "ਇਹ ਲਿੰਕ ਇੱਕ ਘੰਟੇ ਬਾਅਦ ਖਤਮ ਹੋ ਜਾਵੇਗਾ।",
		ignore: "ਜੇ ਤੁਸੀਂ ਇਹ ਬੇਨਤੀ ਨਹੀਂ ਕੀਤੀ, ਤਾਂ ਇਸ ਈਮੇਲ ਨੂੰ ਅਣਡਿੱਠ ਕਰ ਸਕਦੇ ਹੋ।",
		footer: "Email Explorer - ਪਾਸਵਰਡ ਰੀਸੈੱਟ",
	},
	si: {
		subject: "මුරපදය යළි සකසන්න",
		heading: "මුරපදය යළි සකසන්න",
		intro: "ඔබේ මුරපදය යළි සැකසීමේ ඉල්ලීමක් අපට ලැබුණි. ඉදිරියට යාමට පහත බොත්තම ක්ලික් කරන්න.",
		button: "මුරපදය යළි සකසන්න",
		copyPrompt: "නැතහොත් මෙම සබැඳිය ඔබේ බ්‍රව්සරයට පිටපත් කරන්න:",
		expiry: "මෙම සබැඳිය පැයකින් කල් ඉකුත් වේ.",
		ignore: "ඔබ මෙය ඉල්ලා නොමැති නම්, මෙම ඊමේලය නොසලකා හැරිය හැක.",
		footer: "Email Explorer - මුරපදය යළි සැකසීම",
	},
	ta: {
		subject: "கடவுச்சொல்லை மீட்டமைக்கவும்",
		heading: "கடவுச்சொல்லை மீட்டமைக்கவும்",
		intro:
			"உங்கள் கடவுச்சொல்லை மீட்டமைக்கும் கோரிக்கை எங்களுக்கு வந்துள்ளது. தொடர கீழே உள்ள பொத்தானைக் கிளிக் செய்யவும்.",
		button: "கடவுச்சொல்லை மீட்டமை",
		copyPrompt: "அல்லது இந்த இணைப்பை உங்கள் உலாவியில் நகலெடுத்து ஒட்டவும்:",
		expiry: "இந்த இணைப்பு ஒரு மணி நேரத்தில் காலாவதியாகும்.",
		ignore: "நீங்கள் இதைக் கோரவில்லை என்றால், இந்த மின்னஞ்சலைப் புறக்கணிக்கலாம்.",
		footer: "Email Explorer - கடவுச்சொல் மீட்டமைப்பு",
	},
	te: {
		subject: "పాస్‌వర్డ్ రీసెట్ చేయండి",
		heading: "పాస్‌వర్డ్ రీసెట్ చేయండి",
		intro: "మీ పాస్‌వర్డ్ రీసెట్ చేయమనే అభ్యర్థన మాకు అందింది. కొనసాగించడానికి కింది బటన్‌ను క్లిక్ చేయండి.",
		button: "పాస్‌వర్డ్ రీసెట్ చేయండి",
		copyPrompt: "లేదా ఈ లింక్‌ను మీ బ్రౌజర్‌లో కాపీ చేసి అతికించండి:",
		expiry: "ఈ లింక్ ఒక గంట తర్వాత గడువు ముగుస్తుంది.",
		ignore: "మీరు దీన్ని అభ్యర్థించకపోతే, ఈ ఇమెయిల్‌ను విస్మరించవచ్చు.",
		footer: "Email Explorer - పాస్‌వర్డ్ రీసెట్",
	},
	ur: {
		subject: "پاس ورڈ دوبارہ ترتیب دیں",
		heading: "پاس ورڈ دوبارہ ترتیب دیں",
		intro:
			"ہمیں آپ کا پاس ورڈ دوبارہ ترتیب دینے کی درخواست موصول ہوئی ہے۔ جاری رکھنے کے لیے نیچے دیے گئے بٹن پر کلک کریں۔",
		button: "پاس ورڈ دوبارہ ترتیب دیں",
		copyPrompt: "یا یہ لنک اپنے براؤزر میں کاپی کر کے چسپاں کریں:",
		expiry: "یہ لنک ایک گھنٹے بعد ختم ہو جائے گا۔",
		ignore:
			"اگر آپ نے یہ درخواست نہیں کی تو اس ای میل کو نظر انداز کر سکتے ہیں۔",
		footer: "Email Explorer - پاس ورڈ ری سیٹ",
	},

	fil: {
		subject: "I-reset ang iyong password",
		heading: "I-reset ang iyong password",
		intro:
			"Nakatanggap kami ng kahilingan na i-reset ang iyong password. I-click ang button sa ibaba para magpatuloy.",
		button: "I-reset ang password",
		copyPrompt: "O kopyahin at i-paste ang link na ito sa iyong browser:",
		expiry: "Mag-e-expire ang link na ito sa loob ng isang oras.",
		ignore:
			"Kung hindi ikaw ang humiling nito, maaari mong balewalain ang email na ito.",
		footer: "Email Explorer - Pag-reset ng password",
	},
	id: {
		subject: "Atur ulang kata sandi Anda",
		heading: "Atur ulang kata sandi Anda",
		intro:
			"Kami menerima permintaan untuk mengatur ulang kata sandi Anda. Klik tombol di bawah untuk melanjutkan.",
		button: "Atur ulang kata sandi",
		copyPrompt: "Atau salin dan tempel tautan ini ke peramban Anda:",
		expiry: "Tautan ini kedaluwarsa dalam satu jam.",
		ignore: "Jika Anda tidak meminta ini, abaikan saja email ini.",
		footer: "Email Explorer - Pengaturan ulang kata sandi",
	},
	km: {
		subject: "កំណត់ពាក្យសម្ងាត់ឡើងវិញ",
		heading: "កំណត់ពាក្យសម្ងាត់ឡើងវិញ",
		intro: "យើងបានទទួលសំណើកំណត់ពាក្យសម្ងាត់របស់អ្នកឡើងវិញ។ សូមចុចប៊ូតុងខាងក្រោមដើម្បីបន្ត។",
		button: "កំណត់ពាក្យសម្ងាត់ឡើងវិញ",
		copyPrompt: "ឬចម្លងតំណនេះទៅក្នុងកម្មវិធីរុករករបស់អ្នក៖",
		expiry: "តំណនេះនឹងផុតកំណត់ក្នុងរយៈពេលមួយម៉ោង។",
		ignore: "ប្រសិនបើអ្នកមិនបានស្នើសុំ សូមមិនអើពើនឹងអ៊ីមែលនេះ។",
		footer: "Email Explorer - កំណត់ពាក្យសម្ងាត់ឡើងវិញ",
	},
	lo: {
		subject: "ຕັ້ງລະຫັດຜ່ານໃໝ່",
		heading: "ຕັ້ງລະຫັດຜ່ານໃໝ່",
		intro: "ພວກເຮົາໄດ້ຮັບຄຳຮ້ອງຂໍຕັ້ງລະຫັດຜ່ານຂອງທ່ານໃໝ່. ກົດປຸ່ມຂ້າງລຸ່ມນີ້ເພື່ອດຳເນີນຕໍ່.",
		button: "ຕັ້ງລະຫັດຜ່ານໃໝ່",
		copyPrompt: "ຫຼື ສຳເນົາລິ້ງນີ້ໃສ່ໃນເບຣົາເຊີຂອງທ່ານ:",
		expiry: "ລິ້ງນີ້ຈະໝົດອາຍຸໃນໜຶ່ງຊົ່ວໂມງ.",
		ignore: "ຖ້າທ່ານບໍ່ໄດ້ຮ້ອງຂໍ, ທ່ານສາມາດບໍ່ສົນໃຈອີເມວນີ້ໄດ້.",
		footer: "Email Explorer - ຕັ້ງລະຫັດຜ່ານໃໝ່",
	},
	ms: {
		subject: "Tetapkan semula kata laluan anda",
		heading: "Tetapkan semula kata laluan anda",
		intro:
			"Kami menerima permintaan untuk menetapkan semula kata laluan anda. Klik butang di bawah untuk meneruskan.",
		button: "Tetapkan semula kata laluan",
		copyPrompt: "Atau salin dan tampal pautan ini ke dalam pelayar anda:",
		expiry: "Pautan ini tamat tempoh dalam masa satu jam.",
		ignore: "Jika anda tidak membuat permintaan ini, abaikan sahaja e-mel ini.",
		footer: "Email Explorer - Penetapan semula kata laluan",
	},
	my: {
		subject: "စကားဝှက် ပြန်လည်သတ်မှတ်ရန်",
		heading: "စကားဝှက် ပြန်လည်သတ်မှတ်ရန်",
		intro:
			"သင့်စကားဝှက်ကို ပြန်လည်သတ်မှတ်ရန် တောင်းဆိုချက် ရရှိပါသည်။ ဆက်လက်ဆောင်ရွက်ရန် အောက်ပါခလုတ်ကို နှိပ်ပါ။",
		button: "စကားဝှက် ပြန်လည်သတ်မှတ်ရန်",
		copyPrompt: "သို့မဟုတ် ဤလင့်ခ်ကို သင့်ဘရောက်ဇာတွင် ကူးထည့်ပါ။",
		expiry: "ဤလင့်ခ်သည် တစ်နာရီအကြာတွင် သက်တမ်းကုန်ပါမည်။",
		ignore: "သင်မတောင်းဆိုခဲ့ပါက ဤအီးမေးလ်ကို လျစ်လျူရှုနိုင်ပါသည်။",
		footer: "Email Explorer - စကားဝှက် ပြန်လည်သတ်မှတ်ခြင်း",
	},
	th: {
		subject: "ตั้งรหัสผ่านใหม่",
		heading: "ตั้งรหัสผ่านใหม่",
		intro: "เราได้รับคำขอตั้งรหัสผ่านใหม่ของคุณ คลิกปุ่มด้านล่างเพื่อดำเนินการต่อ",
		button: "ตั้งรหัสผ่านใหม่",
		copyPrompt: "หรือคัดลอกลิงก์นี้ไปวางในเบราว์เซอร์ของคุณ:",
		expiry: "ลิงก์นี้จะหมดอายุในหนึ่งชั่วโมง",
		ignore: "หากคุณไม่ได้เป็นผู้ขอ สามารถเพิกเฉยต่ออีเมลนี้ได้",
		footer: "Email Explorer - ตั้งรหัสผ่านใหม่",
	},
	vi: {
		subject: "Đặt lại mật khẩu của bạn",
		heading: "Đặt lại mật khẩu của bạn",
		intro:
			"Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu của bạn. Nhấp vào nút bên dưới để tiếp tục.",
		button: "Đặt lại mật khẩu",
		copyPrompt: "Hoặc sao chép liên kết này vào trình duyệt của bạn:",
		expiry: "Liên kết này sẽ hết hạn sau một giờ.",
		ignore: "Nếu bạn không yêu cầu điều này, bạn có thể bỏ qua email này.",
		footer: "Email Explorer - Đặt lại mật khẩu",
	},
};

/**
 * Still only the three languages this fork started with. A locale with no
 * entry here reads the Japanese wording rather than being refused, which is
 * why the table is Partial and the pick below falls back per table instead of
 * inside resolveMailLocale.
 */
const EMAIL_CHANGE: Partial<Record<MailLocale, LinkEmailStrings>> = {
	ja: {
		subject: "メールアドレス変更の確認",
		heading: "メールアドレス変更の確認",
		intro:
			"ログイン用メールアドレスをこのアドレスに変更するリクエストを受け付けました。下記のボタンをクリックすると変更が確定します。",
		button: "このアドレスに変更する",
		copyPrompt: "またはこちらのリンクをブラウザにコピー＆ペーストしてください:",
		expiry: "このリンクの有効期限は1時間です。",
		ignore:
			"心当たりがない場合は、このメールを無視していただいて問題ありません。変更は行われません。",
		footer: "Email Explorer - メールアドレス変更",
	},
	en: {
		subject: "Confirm your new email address",
		heading: "Confirm your new email address",
		intro:
			"We received a request to move your sign-in address to this one. Click the button below to confirm the change.",
		button: "Confirm this address",
		copyPrompt: "Or copy and paste this link into your browser:",
		expiry: "This link expires in one hour.",
		ignore:
			"If you did not request this, you can ignore this email. Nothing will change.",
		footer: "Email Explorer - Email address change",
	},
	de: {
		subject: "Neue E-Mail-Adresse bestätigen",
		heading: "Neue E-Mail-Adresse bestätigen",
		intro:
			"Es wurde angefragt, Ihre Anmeldeadresse auf diese Adresse zu ändern. Klicken Sie auf die Schaltfläche unten, um die Änderung zu bestätigen.",
		button: "Diese Adresse bestätigen",
		copyPrompt:
			"Oder kopieren Sie diesen Link und fügen Sie ihn in Ihren Browser ein:",
		expiry: "Dieser Link ist eine Stunde lang gültig.",
		ignore:
			"Falls Sie das nicht angefordert haben, können Sie diese E-Mail ignorieren. Es wird nichts geändert.",
		footer: "Email Explorer - Änderung der E-Mail-Adresse",
	},
};

/**
 * Picks the wording for one table. The requested locale is honoured when that
 * table has it and otherwise falls back to Japanese, so a table that covers
 * fewer languages than MAIL_LOCALES still answers every accepted request.
 */
function pickStrings(
	table: Partial<Record<MailLocale, LinkEmailStrings>>,
	locale: string | undefined,
): { lang: MailLocale; strings: LinkEmailStrings } {
	const wanted = resolveMailLocale(locale);
	const strings = table[wanted];
	if (strings) return { lang: wanted, strings };
	return {
		lang: DEFAULT_MAIL_LOCALE,
		strings: table[DEFAULT_MAIL_LOCALE] as LinkEmailStrings,
	};
}

function buildLinkEmail(
	lang: MailLocale,
	s: LinkEmailStrings,
	link: string,
): { subject: string; html: string; text: string } {
	const dir = RTL_LOCALES.has(lang) ? "rtl" : "ltr";
	const fontStack = FONT_STACKS[lang] ?? DEFAULT_FONT_STACK;
	return {
		subject: s.subject,
		html: `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { font-family: ${fontStack}; line-height: 1.6; color: #333; direction: ${dir}; }
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
			<a href="${link}" class="button">${s.button}</a>
			<p>${s.copyPrompt}</p>
			<p><a href="${link}" style="color: #4F46E5; word-break: break-all;" dir="ltr">${link}</a></p>
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

${link}

${s.expiry}

${s.ignore}`,
	};
}

export function buildPasswordResetEmail(
	locale: string | undefined,
	resetLink: string,
): { subject: string; html: string; text: string } {
	const { lang, strings } = pickStrings(PASSWORD_RESET, locale);
	return buildLinkEmail(lang, strings, resetLink);
}

export function buildEmailChangeEmail(
	locale: string | undefined,
	confirmLink: string,
): { subject: string; html: string; text: string } {
	const { lang, strings } = pickStrings(EMAIL_CHANGE, locale);
	return buildLinkEmail(lang, strings, confirmLink);
}
