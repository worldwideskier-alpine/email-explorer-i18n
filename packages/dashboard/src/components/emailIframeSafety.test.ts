import { describe, expect, it } from "vitest";
import { frameDocument } from "@/utils/messageFrame";

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

/**
 * The body of the one computed that builds what the frame is given, and
 * nothing past it.
 *
 * An earlier pattern ended at a closing the computed it looked for did not
 * have, so it ran on lazily into the next computed, and a call moved out of
 * the right one into the wrong one still passed. Checked here, not assumed:
 * whatever this returns must not contain a second `computed(`.
 */
function srcdocComputed(): string {
	const found = /const srcdoc = computed\(([\s\S]*?)\n\);/.exec(iframe)?.[1];
	if (!found) throw new Error("the srcdoc computed was not found");
	if (found.includes("computed(")) {
		throw new Error("the srcdoc match ran past its own computed");
	}
	return found;
}

describe("the frame that shows a message body", () => {
	/**
	 * The whole point. `srcdoc` is what the frame parses, and parsing is when
	 * the fetches happen -- so the stripped body has to be what goes into it.
	 * Handing it the raw body and cleaning up in the load handler would leave
	 * the pixel already reported and the picture merely gone.
	 */
	it("strips the body before the frame is given it, not after", () => {
		// The frame is handed this computed and nothing else, and the flag
		// goes into the same call that builds the document -- where the strip
		// runs on the one parse, before anything is serialised
		// (messageFrame.test.ts holds that nothing is left to fetch).
		expect(iframe).toContain(':srcdoc="srcdoc"');
		expect(srcdocComputed()).toContain(
			"blockRemoteContent: props.blockRemoteContent",
		);

		// And there is no afterwards to do it in: the component has no load
		// handler and no ref to reach the frame's document with.
		expect(iframe).not.toContain("onLoad");
		expect(iframe).not.toContain("contentDocument");
		expect(iframe).not.toMatch(/@load/);
	});

	/**
	 * And it is the only thing doing it. A frame policy was the obvious second
	 * layer and it does not work: a `<meta http-equiv="Content-Security-Policy">`
	 * inside a `srcdoc` document is not enforced -- the element is there in the
	 * DOM and every image is fetched anyway. It was removed rather than left in
	 * place looking like protection, and this says so, so that nobody puts it
	 * back and trusts the stripping less because of it.
	 *
	 * Asked of the markup rather than of the file. It was the whole file, and
	 * that turned out to forbid *writing down* what the policy does -- the
	 * comment explaining that the page's own CSP is what blocks a link from
	 * navigating the frame tripped it. A rule against a `<meta>` element
	 * should not be a rule against naming the thing.
	 */
	it("does not pretend a frame policy is holding anything up", () => {
		expect(iframe).not.toMatch(/http-equiv/i);
		// The frame's own markup is built in utils/messageFrame.ts now, so it is
		// asked there -- of what it produces, not of how it is written.
		const empty = frameDocument("");
		expect(empty).not.toMatch(/http-equiv/i);
		expect(empty).not.toContain("Content-Security-Policy");
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
	 * Where a link goes is decided on the string, before the frame is given
	 * it -- not in a load handler, and not on a click.
	 *
	 * The load handler is the one that cost a deploy. A frame does not fire
	 * `load` until every image in it has arrived, and a marketing message
	 * carries twenty of them; measured in Chromium, three seconds into a
	 * message with one slow picture the text was on screen and tappable, the
	 * frame had not fired `load`, and the links still read `target=""`.
	 * Tapping one then reproduced the reported grey panel exactly -- on the
	 * build that was supposed to have fixed it.
	 *
	 * A click handler is no better and was what came before: `window.open`
	 * from one is a popup a browser may refuse, and by then the handler has
	 * already cancelled the navigation, so the link does nothing at all; and
	 * a middle click, a long press and "open in new tab" never reach it.
	 */
	it("decides where a link goes before the frame can be tapped", () => {
		expect(srcdocComputed()).toContain("prepareFrame(");
		// The two ways of being too late.
		expect(iframe).not.toContain("window.open");
		expect(iframe).not.toContain('addEventListener("click"');
		expect(iframe).not.toContain("addEventListener");
	});

	/**
	 * The spam folder's half of the same timing. While this waited for
	 * `load`, a phishing message's links were live and tappable for as long
	 * as its images took to arrive -- and its images are on the sender's own
	 * servers, so the sender chooses how long that is.
	 */
	it("makes a spam message inert on the same string, not later", () => {
		expect(srcdocComputed()).toContain("disableLinks: props.disableLinks");
	});

	// Both only under the flag: an ordinary message still shows its pictures.
	it("leaves a message outside the spam folder alone", () => {
		// The flag is passed through as it arrives, not forced on; that an
		// ordinary message keeps its pictures is messageFrame.test.ts's.
		expect(srcdocComputed()).toContain(
			"blockRemoteContent: props.blockRemoteContent",
		);
		expect(srcdocComputed()).not.toMatch(/blockRemoteContent:\s*true/);
	});
});

describe("what the message view asks for", () => {
	// Decided by the folder the message is in, not the one in the address:
	// a search result links here with none. spamWherever.test.ts mounts the
	// screen and holds that; this only keeps the wiring findable.
	it("turns it on for the spam folder", () => {
		expect(detail).toMatch(/blocksRemoteContent[\s\S]*?currentFolder.*"spam"/);
		expect(detail).toMatch(
			/currentFolder = computed\([\s\S]*?email\.value\?\.folder_id/,
		);
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
