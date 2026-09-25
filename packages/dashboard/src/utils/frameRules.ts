/**
 * The shape every rule about a message frame takes, and the namespaces they
 * share.
 *
 * A rule is one definition used twice: `find` says which elements break it,
 * `fix` mends one. Rewriting a message applies `fix` to what `find` returns;
 * checking the frame's own reading of the result asks that `find` returns
 * nothing. Before this, the rewrite and the check were separate code saying
 * the same thing -- defuse beside isSafe, stripRemoteContentFrom beside
 * fetchesSomething -- and a rule added to one and not the other would have
 * been rewritten but never checked, with nothing to say so.
 */

export const XLINK = "http://www.w3.org/1999/xlink";
export const MATHML = "http://www.w3.org/1998/Math/MathML";

export interface FrameRule {
	/** Every element in the document that breaks the rule. */
	find(doc: Document): Element[];
	/** Mends one of them, in place. */
	fix(element: Element): void;
}

/** Applies each rule to what it finds, in order. */
export function applyRules(doc: Document, rules: readonly FrameRule[]): void {
	for (const rule of rules) {
		for (const element of rule.find(doc)) rule.fix(element);
	}
}

/** Whether no rule finds anything to mend. */
export function rulesHold(doc: Document, rules: readonly FrameRule[]): boolean {
	return rules.every((rule) => rule.find(doc).length === 0);
}

/** Where an element says it goes: `href`, or SVG's older `xlink:href`. */
export function destinationOf(element: Element): string | null {
	return element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");
}

/** Takes an element's destination away, in both spellings. */
export function removeDestination(element: Element): void {
	element.removeAttribute("href");
	element.removeAttributeNS(XLINK, "href");
}
