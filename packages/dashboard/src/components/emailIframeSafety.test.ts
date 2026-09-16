import { describe, expect, it } from "vitest";

/**
 * The frame is wired the way the spam folder needs it.
 *
 * remoteContent.test.ts proves the stripping works; this proves it is
 * actually reached, and reached in time. Both halves are needed, because the
 * failure that matters here is not a wrong result -- it is a correct result
 * arriving after the request has already gone out.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types,
 * and there is no @vue/test-utils here to mount a component with.
 */

const read = (files: Record<string, string>, name: string) => {
	const entry = Object.entries(files).find(([path]) => path.endsWith(name));
	if (!entry) throw new Error(`${name} not found`);
	return entry[1];
};

const components = import.meta.glob("./*.vue", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const views = import.meta.glob("../views/*.vue", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const iframe = read(components, "EmailIframe.vue");
const detail = read(views, "EmailDetail.vue");

describe("the frame that shows a message body", () => {
	/**
	 * The whole point. `srcdoc` is what the frame parses, and parsing is when
	 * the fetches happen -- so the stripped body has to be what goes into it.
	 * Handing it the raw body and cleaning up in the load handler would leave
	 * the pixel already reported and the picture merely gone.
	 */
	it("strips the body before the frame is given it, not after", () => {
		expect(iframe).toContain("stripRemoteContent");

		const srcdocSource = /const fullHtml = computed\(([\s\S]*?)\n\);/.exec(
			iframe,
		)?.[1];
		expect(srcdocSource).toBeTruthy();
		expect(srcdocSource).toContain("renderedBody.value");
		expect(srcdocSource).not.toContain("props.body");

		// And the load handler is not where any of it happens.
		const onLoad = /const onLoad = \(\) => \{([\s\S]*?)\n\};/.exec(iframe)?.[1];
		expect(onLoad).toBeTruthy();
		expect(onLoad).not.toContain("stripRemoteContent");
	});

	/**
	 * And it is the only thing doing it. A frame policy was the obvious second
	 * layer and it does not work: a `<meta http-equiv="Content-Security-Policy">`
	 * inside a `srcdoc` document is not enforced -- the element is there in the
	 * DOM and every image is fetched anyway. It was removed rather than left in
	 * place looking like protection, and this says so, so that nobody puts it
	 * back and trusts the stripping less because of it.
	 */
	it("does not pretend a frame policy is holding anything up", () => {
		expect(iframe).not.toContain("Content-Security-Policy");
	});

	/**
	 * The two flags a link's behaviour rests on, and the one that is gone.
	 *
	 * Measured in Chromium, against a destination sending `X-Frame-Options:
	 * DENY`, with the sandbox as it was written here:
	 *
	 *   - A tab opened by the frame inherited this sandbox. The probe page it
	 *     opened reported "scripts did NOT run" and had an opaque origin --
	 *     which is most sites rendered blank. Adding
	 *     `allow-popups-to-escape-sandbox` made the same page report its own
	 *     origin.
	 *   - `allow-top-navigation-by-user-activation` let a message replace this
	 *     whole application. Nothing needs it now that every outbound link is
	 *     given `target="_blank"`, and what it permits is the shape of a
	 *     phishing page, so it was taken away.
	 *
	 * `allow-scripts` has never been here and must not arrive: with
	 * `allow-same-origin` beside it the pair hands a message full run of this
	 * origin, and the two together are what a sandbox exists to keep apart.
	 */
	it("may open a tab, may not take the window, may not run code", () => {
		const sandbox = /sandbox="([^"]*)"/.exec(iframe)?.[1];
		expect(sandbox).toBeTruthy();
		const flags = (sandbox as string).split(/\s+/);

		expect(flags).toContain("allow-popups");
		expect(flags).toContain("allow-popups-to-escape-sandbox");
		expect(flags).not.toContain("allow-top-navigation-by-user-activation");
		expect(flags).not.toContain("allow-top-navigation");
		expect(flags).not.toContain("allow-scripts");
		expect(flags).not.toContain("allow-forms");
	});

	/**
	 * And where a link is sent is decided for every link in the body, by the
	 * pass utils/emailLinks.test.ts holds -- not by a click handler, which is
	 * what this replaced. `window.open` from a handler is a popup a browser
	 * may refuse, and by then the handler has already cancelled the
	 * navigation, so the link does nothing; and a middle click, a long press
	 * and "open in new tab" never reached the handler in the first place.
	 */
	it("decides where a link goes on the link, not on a click", () => {
		const onLoad = /const onLoad = \(\) => \{([\s\S]*?)\n\};/.exec(iframe)?.[1];
		expect(onLoad).toContain("sendLinksToANewTab(doc)");
		expect(iframe).not.toContain("window.open");
		expect(iframe).not.toContain('addEventListener("click"');
	});

	// Both only under the flag: an ordinary message still shows its pictures.
	it("leaves a message outside the spam folder alone", () => {
		expect(iframe).toContain("props.blockRemoteContent ? stripRemoteContent");
		expect(iframe).toContain("props.blockRemoteContent");
	});
});

describe("what the message view asks for", () => {
	it("turns it on for the spam folder", () => {
		expect(detail).toMatch(/blocksRemoteContent[\s\S]*?fromFolder.*"spam"/);
		expect(detail).toContain(':block-remote-content="blocksRemoteContent"');
	});

	/**
	 * An inline attachment in a spam message is left as its `cid:` reference.
	 * Substituting it would mark the attachment as already on screen, and it
	 * would then be stripped from the body -- so it would appear nowhere at
	 * all, neither shown above nor listed below. Asking not to be tracked is
	 * not a reason to lose a file.
	 */
	it("does not swallow an inline attachment on the way", () => {
		expect(detail).toMatch(
			/if \(blocksRemoteContent\.value\) return \{ html, inlineIds \};/,
		);
	});
});
