import {
	DEFAULT_MAIL_LOCALE,
	MAIL_LOCALES,
	type MailLocale,
} from "./mail-templates";

/**
 * What a device whose session has run out is told when new mail comes
 * (push-notify.ts): that there is some, and to open the app -- nothing about
 * the message. "Open" rather than "sign in": a device whose row came from
 * before rows named a session may still be signed in, and opening is all it
 * needs.
 *
 * Keyed by every language the dashboard offers, as the mail the Worker sends
 * is, so the compiler refuses a table with one missing. The device says
 * which it displays when it subscribes (routes/push.ts).
 */
export const OPEN_THE_APP: Readonly<Record<MailLocale, string>> = {
	ja: "新着メールが届いています。この端末でアプリを開いてください。メールを読めるほか、通知もこれまでどおり届きます。",
	ko: "새 메일이 도착했습니다. 메일을 읽고 알림을 계속 받으려면 이 기기에서 앱을 여세요.",
	mn: "Шинэ захидал ирлээ. Үүнийг уншиж, мэдэгдэл үргэлжлүүлэн авахын тулд энэ төхөөрөмж дээр аппаа нээнэ үү.",
	yue: "有新信到咗。喺呢部機打開應用程式就可以睇，亦可以繼續收到通知。",
	"zh-Hans": "有新邮件到达。请在此设备上打开应用，以阅读邮件并继续接收通知。",
	"zh-Hant":
		"有新郵件送達。請在這台裝置上開啟應用程式，以閱讀郵件並繼續接收通知。",

	az: "Yeni məktub gəlib. Onu oxumaq və bildiriş almağa davam etmək üçün bu cihazda tətbiqi açın.",
	be: "Прыйшла новая пошта. Адкрыйце праграму на гэтай прыладзе, каб прачытаць яе і далей атрымліваць апавяшчэнні.",
	bg: "Пристигна нова поща. Отворете приложението на това устройство, за да я прочетете и да продължите да получавате известия.",
	bs: "Stigla je nova pošta. Otvorite aplikaciju na ovom uređaju da biste je pročitali i nastavili primati obavještenja.",
	ca: "Ha arribat correu nou. Obriu l'aplicació en aquest dispositiu per llegir-lo i continuar rebent avisos.",
	cnr: "Stigla je nova pošta. Otvorite aplikaciju na ovom uređaju da biste je pročitali i nastavili da primate obavještenja.",
	cs: "Přišla nová pošta. Otevřete aplikaci na tomto zařízení, abyste si ji mohli přečíst a dál dostávat upozornění.",
	da: "Der er kommet ny post. Åbn appen på denne enhed for at læse den og blive ved med at få besked.",
	de: "Neue Post ist eingegangen. Öffnen Sie die App auf diesem Gerät, um sie zu lesen und weiterhin Benachrichtigungen zu erhalten.",
	el: "Έφτασε νέο μήνυμα. Ανοίξτε την εφαρμογή σε αυτή τη συσκευή για να το διαβάσετε και να συνεχίσετε να λαμβάνετε ειδοποιήσεις.",
	en: "New mail has arrived. Open the app on this device to read it and to keep getting notifications.",
	es: "Ha llegado correo nuevo. Abre la aplicación en este dispositivo para leerlo y seguir recibiendo avisos.",
	et: "Saabus uus kiri. Ava selles seadmes rakendus, et seda lugeda ja teateid edasi saada.",
	fi: "Uutta postia on saapunut. Avaa sovellus tällä laitteella, niin voit lukea sen ja saat ilmoituksia jatkossakin.",
	fr: "Un nouveau message est arrivé. Ouvrez l'application sur cet appareil pour le lire et continuer à recevoir des notifications.",
	ga: "Tá post nua tagtha. Oscail an aip ar an ngléas seo chun é a léamh agus chun leanúint ort ag fáil fógraí.",
	hr: "Stigla je nova pošta. Otvorite aplikaciju na ovom uređaju da biste je pročitali i nastavili primati obavijesti.",
	hu: "Új levél érkezett. Nyissa meg az alkalmazást ezen az eszközön, hogy elolvashassa, és továbbra is kapjon értesítéseket.",
	hy: "Նոր նամակ է եկել։ Բացեք հավելվածը այս սարքում՝ այն կարդալու և ծանուցումներ ստանալը շարունակելու համար։",
	is: "Nýr póstur hefur borist. Opnaðu appið í þessu tæki til að lesa hann og fá áfram tilkynningar.",
	it: "È arrivata nuova posta. Apri l'app su questo dispositivo per leggerla e continuare a ricevere notifiche.",
	ka: "ახალი წერილი მოვიდა. გახსენით აპი ამ მოწყობილობაზე, რომ წაიკითხოთ და კვლავ მიიღოთ შეტყობინებები.",
	lb: "Nei Post ass ukomm. Maacht d'App op dësem Apparat op, fir se ze liesen an ëmmer nach Bescheed ze kréien.",
	lt: "Atėjo naujas laiškas. Atidarykite programėlę šiame įrenginyje, kad jį perskaitytumėte ir toliau gautumėte pranešimus.",
	lv: "Ir pienākusi jauna vēstule. Atveriet lietotni šajā ierīcē, lai to izlasītu un turpinātu saņemt paziņojumus.",
	mk: "Пристигна нова пошта. Отворете ја апликацијата на овој уред за да ја прочитате и да продолжите да добивате известувања.",
	mt: "Waslet posta ġdida. Iftaħ l-app fuq dan l-apparat biex taqraha u tibqa' tirċievi notifiki.",
	nb: "Det har kommet ny post. Åpne appen på denne enheten for å lese den og fortsatt få varsler.",
	nl: "Er is nieuwe post binnengekomen. Open de app op dit apparaat om die te lezen en meldingen te blijven ontvangen.",
	nn: "Det har kome ny post. Opna appen på denne eininga for å lese posten og framleis få varsel.",
	pl: "Przyszła nowa poczta. Otwórz aplikację na tym urządzeniu, aby ją przeczytać i nadal otrzymywać powiadomienia.",
	pt: "Chegou correio novo. Abra a aplicação neste dispositivo para o ler e continuar a receber avisos.",
	rm: "Nova posta è arrivada. Avra l'app sin quest apparat per la leger e per cuntinuar a retschaiver communicaziuns.",
	ro: "Au sosit mesaje noi. Deschideți aplicația pe acest dispozitiv pentru a le citi și pentru a primi în continuare notificări.",
	ru: "Пришла новая почта. Откройте приложение на этом устройстве, чтобы прочитать её и продолжать получать уведомления.",
	sk: "Prišla nová pošta. Otvorte aplikáciu na tomto zariadení, aby ste si ju mohli prečítať a naďalej dostávať upozornenia.",
	sl: "Prispela je nova pošta. Odprite aplikacijo na tej napravi, da jo preberete in še naprej prejemate obvestila.",
	sq: "Ka mbërritur postë e re. Hapni aplikacionin në këtë pajisje për ta lexuar dhe për të vazhduar të merrni njoftime.",
	sr: "Стигла је нова пошта. Отворите апликацију на овом уређају да бисте је прочитали и наставили да примате обавештења.",
	sv: "Ny post har kommit. Öppna appen på den här enheten för att läsa den och fortsätta få aviseringar.",
	tr: "Yeni posta geldi. Okumak ve bildirim almaya devam etmek için bu cihazda uygulamayı açın.",
	uk: "Надійшла нова пошта. Відкрийте застосунок на цьому пристрої, щоб прочитати її й далі отримувати сповіщення.",

	ar: "وصل بريد جديد. افتح التطبيق على هذا الجهاز لقراءته ولمواصلة تلقّي الإشعارات.",
	ckb: "پۆستی نوێ هات. ئەپەکە لەم ئامێرەدا بکەرەوە بۆ خوێندنەوەی و بۆ ئەوەی هەر ئاگادارکردنەوە وەربگریت.",
	fa: "نامهٔ تازه رسیده است. برای خواندن آن و ادامهٔ دریافت اعلان‌ها، برنامه را روی این دستگاه باز کنید.",
	he: "הגיע דואר חדש. פתחו את האפליקציה במכשיר הזה כדי לקרוא אותו ולהמשיך לקבל התראות.",

	bn: "নতুন চিঠি এসেছে। এটি পড়তে এবং বিজ্ঞপ্তি পেতে থাকতে এই যন্ত্রে অ্যাপটি খুলুন।",
	gu: "નવી ટપાલ આવી છે. તે વાંચવા અને સૂચનાઓ મળતી રહે તે માટે આ ઉપકરણ પર ઍપ ખોલો.",
	hi: "नई मेल आई है। उसे पढ़ने और सूचनाएँ मिलती रहें, इसके लिए इस डिवाइस पर ऐप खोलें।",
	kn: "ಹೊಸ ಅಂಚೆ ಬಂದಿದೆ. ಅದನ್ನು ಓದಲು ಮತ್ತು ಸೂಚನೆಗಳನ್ನು ಪಡೆಯುತ್ತಲೇ ಇರಲು ಈ ಸಾಧನದಲ್ಲಿ ಆ್ಯಪ್ ತೆರೆಯಿರಿ.",
	ml: "പുതിയ കത്ത് വന്നിട്ടുണ്ട്. അത് വായിക്കാനും തുടർന്നും അറിയിപ്പുകൾ ലഭിക്കാനും ഈ ഉപകരണത്തിൽ ആപ്പ് തുറക്കുക.",
	mr: "नवीन टपाल आले आहे. ते वाचण्यासाठी आणि सूचना मिळत राहण्यासाठी या उपकरणावर ॲप उघडा.",
	ne: "नयाँ चिठी आएको छ। त्यो पढ्न र सूचना पाइरहन यो यन्त्रमा एप खोल्नुहोस्।",
	or: "ନୂଆ ଚିଠି ଆସିଛି। ତାହା ପଢ଼ିବାକୁ ଏବଂ ସୂଚନା ପାଇବା ଜାରି ରଖିବାକୁ ଏହି ଯନ୍ତ୍ରରେ ଆପ୍ ଖୋଲନ୍ତୁ।",
	pa: "ਨਵੀਂ ਡਾਕ ਆਈ ਹੈ। ਇਸਨੂੰ ਪੜ੍ਹਨ ਅਤੇ ਸੂਚਨਾਵਾਂ ਮਿਲਦੀਆਂ ਰਹਿਣ ਲਈ ਇਸ ਜੰਤਰ ਉੱਤੇ ਐਪ ਖੋਲ੍ਹੋ।",
	si: "නව තැපෑලක් පැමිණ ඇත. එය කියවීමට සහ දිගටම දැනුම්දීම් ලැබීමට මෙම උපාංගයේ යෙදුම විවෘත කරන්න.",
	ta: "புதிய அஞ்சல் வந்துள்ளது. அதைப் படிக்கவும் தொடர்ந்து அறிவிப்புகளைப் பெறவும் இந்தச் சாதனத்தில் செயலியைத் திறக்கவும்.",
	te: "కొత్త మెయిల్ వచ్చింది. దాన్ని చదవడానికి, సమాచారం అందుతూ ఉండడానికి ఈ పరికరంలో యాప్‌ను తెరవండి.",
	ur: "نئی ڈاک آئی ہے۔ اسے پڑھنے اور اطلاعات ملتی رہنے کے لیے اس آلے پر ایپ کھولیں۔",

	fil: "May bagong sulat. Buksan ang app sa device na ito para mabasa ito at patuloy na makatanggap ng abiso.",
	id: "Surat baru telah tiba. Buka aplikasi di perangkat ini untuk membacanya dan tetap menerima pemberitahuan.",
	km: "មានសំបុត្រថ្មីមកដល់។ សូមបើកកម្មវិធីនៅលើឧបករណ៍នេះ ដើម្បីអានវា និងបន្តទទួលការជូនដំណឹង។",
	lo: "ມີຈົດໝາຍໃໝ່ມາຮອດ. ກະລຸນາເປີດແອັບຢູ່ອຸປະກອນນີ້ ເພື່ອອ່ານ ແລະ ຮັບການແຈ້ງເຕືອນຕໍ່ໄປ.",
	ms: "Surat baharu telah tiba. Buka aplikasi pada peranti ini untuk membacanya dan terus menerima pemberitahuan.",
	my: "စာအသစ် ရောက်လာပါပြီ။ ၎င်းကိုဖတ်ရန်နှင့် အသိပေးချက်များ ဆက်လက်ရရှိရန် ဤစက်တွင် အက်ပ်ကို ဖွင့်ပါ။",
	th: "มีจดหมายใหม่มาถึง เปิดแอปบนอุปกรณ์นี้เพื่ออ่านและรับการแจ้งเตือนต่อไป",
	vi: "Bạn có thư mới. Hãy mở ứng dụng trên thiết bị này để đọc thư và tiếp tục nhận thông báo.",
};

/**
 * The words for a device that displays `locale`.
 *
 * A device that never said -- every one subscribed before devices said, the
 * one this was written for among them -- is told in the package's default
 * language (DEFAULT_MAIL_LOCALE, Japanese, which a deployment does not set)
 * and in English, one line each: the default alone left a fork whose readers
 * are not Japanese a line none of them could read. `fallback` is that
 * default, a parameter only so the English-default case can be tested.
 */
export function openTheAppNotice(
	locale: string | null,
	fallback: MailLocale = DEFAULT_MAIL_LOCALE,
): string {
	const known = knownLocale(locale);
	if (known) return OPEN_THE_APP[known];
	return fallback === "en"
		? OPEN_THE_APP.en
		: `${OPEN_THE_APP[fallback]}\n${OPEN_THE_APP.en}`;
}

/**
 * The language a subscribing device names, if the notice has it; anything
 * else is kept as none. Never a reason to refuse the subscription: the
 * dashboard re-sends it on every sign-in and swallows a refusal, so a code
 * this table did not know would have left that device with no notifications
 * and nothing to say so.
 */
export function knownLocale(locale: unknown): MailLocale | null {
	return typeof locale === "string" &&
		(MAIL_LOCALES as readonly string[]).includes(locale)
		? (locale as MailLocale)
		: null;
}
