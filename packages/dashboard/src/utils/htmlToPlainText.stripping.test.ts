import { describe, expect, it } from "vitest";
import { htmlToPlainText } from "./htmlToPlainText";

/**
 * Settings.vue flattens a signature to text before saving it. That used to be
 * `div.innerHTML = html` on a detached div, where an <img src=x onerror=...>
 * can still fire -- so a signature could run script in whoever opened those
 * settings. These cases pin the replacement's behaviour on exactly the markup
 * that made the old one dangerous.
 */
describe("flattening untrusted markup to text", () => {
	it("keeps no attribute from an element that carries a handler", () => {
		const text = htmlToPlainText(
			'<img src="x" onerror="alert(1)"><p>signature</p>',
		);
		expect(text).toBe("signature");
		expect(text).not.toContain("alert");
		expect(text).not.toContain("onerror");
	});

	it("drops an inline script rather than reading it out as text", () => {
		expect(htmlToPlainText("<script>alert(1)</script>Yamada")).toBe("Yamada");
	});

	it("drops an svg onload handler", () => {
		const text = htmlToPlainText('<svg onload="alert(1)"></svg>Yamada');
		expect(text).toBe("Yamada");
	});

	it("leaves an ordinary signature readable", () => {
		expect(
			htmlToPlainText("<p>Example Ltd.</p><p>Sales</p><p>+81-3-0000-0000</p>"),
		).toBe("Example Ltd.\n\nSales\n\n+81-3-0000-0000");
	});
});
