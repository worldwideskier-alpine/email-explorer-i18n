/**
 * The editor's two colour marks, taking a colour and nothing else.
 *
 * A reply or a forward puts the original message into the editor, and the
 * editor is this page -- not the sandboxed frame a message is read in. Tiptap's
 * highlight reads `<mark data-color>` as it stands and writes it back as
 * `style="background-color: <it>; color: inherit"`, so a value with a `;` in
 * it chose the rest of that style: `position: fixed` over the whole dashboard,
 * a `url()` fetched the moment the reply opened, and all of it sent on in the
 * reply. The text colour reads its value out of a `style` split at `;`, which
 * holds today; it goes through the same check so that it does not depend on
 * that staying so.
 *
 * A colour is recognised by its shape rather than by asking the browser:
 * `CSS.supports` would accept anything the browser does, and what is wanted is
 * the small set a mail's colours are written in.
 */

import Highlight from "@tiptap/extension-highlight";
import { Color } from "@tiptap/extension-text-style";
import type { Attribute, Attributes } from "@tiptap/vue-3";

const COLOUR = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([0-9.,%\s/+-]*\)|[a-z]+)$/i;

/** The value if it is one colour, otherwise null. */
export function cssColour(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const colour = value.trim();
	return COLOUR.test(colour) ? colour : null;
}

/** The same attribute, parsing and rendering only what cssColour allows. */
function onlyColours(attribute: Attribute): Attribute {
	return {
		...attribute,
		parseHTML: (element) => cssColour(attribute.parseHTML?.(element)),
		renderHTML: (attributes) =>
			cssColour(attributes.color) === null
				? {}
				: (attribute.renderHTML?.(attributes) ?? {}),
	};
}

export const ColourHighlight = Highlight.extend({
	addAttributes() {
		const inherited: Attributes = this.parent?.() ?? {};
		return inherited.color
			? { ...inherited, color: onlyColours(inherited.color) }
			: inherited;
	},
}).configure({ multicolor: true });

export const TextColour = Color.extend({
	addGlobalAttributes() {
		return (this.parent?.() ?? []).map((global) => ({
			...global,
			attributes: global.attributes.color
				? {
						...global.attributes,
						color: onlyColours(global.attributes.color),
					}
				: global.attributes,
		}));
	},
});
