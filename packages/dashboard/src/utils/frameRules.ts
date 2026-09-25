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

/**
 * `fix` must not decide anything `find` has not already decided: it is only
 * ever handed what `find` returned. A rule with two outcomes is two rules --
 * otherwise `fix` has to work the verdict out again, which is both a second
 * copy of the question and a second time paying for it.
 */
export interface FrameRule {
	find(doc: Document): Element[];
	fix(element: Element): void;
}

export function applyRules(doc: Document, rules: readonly FrameRule[]): void {
	for (const rule of rules) {
		for (const element of rule.find(doc)) rule.fix(element);
	}
}

export function rulesHold(doc: Document, rules: readonly FrameRule[]): boolean {
	return rules.every((rule) => rule.find(doc).length === 0);
}

/**
 * Where an element says it goes. SVG still accepts the older `xlink:href`,
 * which `getAttribute("href")` does not see.
 */
export function destinationOf(element: Element): string | null {
	return element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");
}

export function removeDestination(element: Element): void {
	element.removeAttribute("href");
	element.removeAttributeNS(XLINK, "href");
}

/**
 * The SVG animation elements, by the attribute that makes them one -- found
 * by the selector engine rather than by walking every element and asking.
 */
export const ANIMATIONS = "[attributeName]";

/**
 * What an SVG animation changes, and every value it can set it to.
 *
 * One reading of an animation for every rule that has an opinion about one.
 * There were two, in two files, each with its own trim and its own list, and
 * a refused attribute added to one would not have been refused by the other.
 * The values are all four places an animation can say one: `to`, `from`,
 * `by`, and the `;`-separated `values`.
 */
export function animationOf(element: Element): {
	attribute: string;
	values: string[];
} {
	return {
		attribute: element.getAttribute("attributeName")?.trim() ?? "",
		values: ["to", "from", "by", "values"]
			.map((name) => element.getAttribute(name))
			.filter((value): value is string => value !== null),
	};
}
