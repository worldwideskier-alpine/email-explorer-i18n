/**
 * Noticing that the deployment has moved on, and catching up.
 *
 * Why this exists, plainly: a fix was deployed, verified against production
 * byte for byte, and the person who reported the fault saw no change at all.
 * The application was on their home screen. A page opened that way is never
 * closed -- tapping the icon resumes the document that is already running --
 * so the browser had no occasion to ask for index.html again, and the phone
 * went on running the build it had loaded days earlier. Nothing was broken;
 * the repair simply could not reach the screen.
 *
 * That is not a mail bug, but it decides whether any mail bug can ever be
 * said to be fixed, so it is handled here rather than by asking somebody to
 * force-close an app.
 *
 * What it does not do: poll. It looks when the application comes back to the
 * front, which is exactly the moment a resumed page may be stale, and not
 * more than once a minute.
 *
 * And what it will not do is reload over somebody's writing. A reload throws
 * away an unsent message, and a new build is never worth that -- so when
 * anything is being typed the check simply does nothing and the next resume
 * tries again.
 */

/** Not more than once a minute, however often the app is switched to. */
const QUIET_PERIOD_MS = 60_000;

let lastLookedAt = 0;

/**
 * The entry scripts a page names, as the page itself spells them.
 *
 * Only `<script type="module">`: those are written into index.html at build
 * time and stay put. Locale catalogues and other chunks arrive later as
 * dynamic imports and add `<link rel="modulepreload">` elements to the
 * running document that the served file knows nothing about -- comparing
 * those would report a new build every time somebody changed language.
 */
export function moduleScriptsIn(html: string): string[] {
	const scripts: string[] = [];
	for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
		if (!/\btype\s*=\s*["']?module\b/i.test(tag)) continue;
		const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
		if (src) scripts.push(src);
	}
	return scripts.sort();
}

/** The same question asked of the document this code is running in. */
export function moduleScriptsOf(doc: Document): string[] {
	return [...doc.querySelectorAll('script[type="module"][src]')]
		.map((script) => script.getAttribute("src") ?? "")
		.filter(Boolean)
		.sort();
}

/**
 * Whether these are the same build.
 *
 * Vite puts a hash of the contents in each file name, so a different name is
 * a different build and the same name is the same bytes. An empty list on
 * either side means the question could not be answered -- a dev server, an
 * error page, a captive portal -- and an unanswered question must not be read
 * as "out of date", or the app would reload itself forever.
 */
export function looksLikeANewBuild(
	running: string[],
	served: string[],
): boolean {
	if (running.length === 0 || served.length === 0) return false;
	return running.join(",") !== served.join(",");
}

/**
 * Whether reloading right now would take something away from someone.
 *
 * Deliberately broad: a cursor in any field counts, and so does any text
 * left in a box or in the message editor, focused or not. The cost of being
 * wrong in this direction is that the update waits until the next time the
 * app is opened; the cost of being wrong in the other direction is a message
 * somebody had written.
 */
export function somethingIsBeingWritten(doc: Document): boolean {
	if (holds > 0) return true;
	const active = doc.activeElement;
	if (
		active instanceof HTMLInputElement ||
		active instanceof HTMLTextAreaElement ||
		(active instanceof HTMLElement && active.isContentEditable)
	) {
		return true;
	}
	for (const field of doc.querySelectorAll("textarea")) {
		if (field.value.trim()) return true;
	}
	for (const editor of doc.querySelectorAll('[contenteditable="true"]')) {
		if ((editor.textContent ?? "").trim()) return true;
	}
	// A filled box is writing too: the composer's To and Subject are inputs,
	// and so is a picked attachment. Only boxes someone can type into --
	// a disabled one showing a stored value is not being written.
	for (const field of doc.querySelectorAll("input")) {
		if (field.disabled || field.readOnly) continue;
		if (field.type === "file") {
			if (field.files && field.files.length > 0) return true;
		} else if (TYPED.has(field.type) && field.value.trim()) {
			return true;
		}
	}
	return false;
}

/** Input types somebody types words into. */
const TYPED = new Set(["text", "email", "search", "url", "tel", "password"]);

let holds = 0;

/**
 * Keeps the page from reloading until the returned function is called, for
 * work in progress that shows in no field -- a restore feeding messages to
 * the server one at a time, which a reload would cut off halfway.
 */
export function holdReload(): () => void {
	holds += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds -= 1;
	};
}

/** Asks the server what the page says now, without going through the cache. */
async function servedPage(): Promise<string | null> {
	try {
		const response = await fetch("/index.html", { cache: "no-store" });
		if (!response.ok) return null;
		return await response.text();
	} catch {
		// Offline, or the request was refused. Not knowing is not a reason to
		// do anything.
		return null;
	}
}

async function checkOnce(): Promise<void> {
	const now = Date.now();
	if (now - lastLookedAt < QUIET_PERIOD_MS) return;
	lastLookedAt = now;

	const running = moduleScriptsOf(document);
	if (running.length === 0) return;

	const html = await servedPage();
	if (html === null) return;

	if (!looksLikeANewBuild(running, moduleScriptsIn(html))) return;
	if (somethingIsBeingWritten(document)) return;

	window.location.reload();
}

/**
 * Starts watching. Safe to call once, from the entry point.
 *
 * `visibilitychange` covers switching back to the app; `pageshow` with
 * `persisted` covers a document restored from the back/forward cache, which
 * is a resumed page that fires no load event at all.
 *
 * Neither fires on a first load, which is deliberate: a page that has just
 * been fetched cannot be out of date, and asking anyway would spend a request
 * at every start and put the app inside its own quiet period for the first
 * minute -- exactly the minute in which somebody who just reopened it might
 * switch away and back.
 */
export function watchForANewBuild(): void {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void checkOnce();
	});
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) void checkOnce();
	});
}
