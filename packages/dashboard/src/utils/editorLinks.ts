import Link from "@tiptap/extension-link";

/**
 * The editor's link mark, with the editor's own class and never the
 * sender's.
 *
 * A reply or a forward puts the original into the editor, which is this
 * page, not the sandboxed frame. Tiptap's link read `class` off an `<a>` as
 * it stood, and this page's stylesheet has every utility the dashboard uses:
 * `class="fixed inset-0 z-50 bg-white text-3xl"` laid the sender's words over
 * the whole compose dialog, on this site's own origin, and went out in the
 * reply as well (Claude Security F9). The class of a quoted link is read as
 * absent, so the link takes the one the editor gives every link.
 */
export const QuotedLink = Link.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			class: {
				default: this.options.HTMLAttributes.class ?? null,
				parseHTML: () => null,
			},
		};
	},
});
