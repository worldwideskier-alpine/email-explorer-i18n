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
