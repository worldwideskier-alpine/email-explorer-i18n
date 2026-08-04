import { describe, expect, it } from "vitest";
import { classifyByAuthResults } from "../../src/spam-filter";

const header = (value: string) => [
	{ key: "authentication-results", originalKey: "Authentication-Results", value },
];

describe("classifyByAuthResults", () => {
	it("routes to inbox when there is no Authentication-Results header", () => {
		expect(classifyByAuthResults([])).toBe("inbox");
	});

	it("routes to inbox when everything passes", () => {
		expect(
			classifyByAuthResults(
				header(
					"mx.example.com; spf=pass smtp.mailfrom=sender.com; dkim=pass header.i=@sender.com; dmarc=pass header.from=sender.com",
				),
			),
		).toBe("inbox");
	});

	it("routes to spam when dmarc fails", () => {
		expect(
			classifyByAuthResults(
				header(
					"mx.example.com; spf=pass smtp.mailfrom=sender.com; dkim=pass header.i=@sender.com; dmarc=fail header.from=sender.com",
				),
			),
		).toBe("spam");
	});

	it("routes to spam when both spf and dkim fail", () => {
		expect(
			classifyByAuthResults(
				header("mx.example.com; spf=fail smtp.mailfrom=sender.com; dkim=fail header.i=@sender.com"),
			),
		).toBe("spam");
	});

	it("routes to inbox when only spf fails but dkim passes", () => {
		expect(
			classifyByAuthResults(
				header("mx.example.com; spf=fail smtp.mailfrom=sender.com; dkim=pass header.i=@sender.com"),
			),
		).toBe("inbox");
	});

	it("routes to inbox for soft signals like softfail/neutral/temperror", () => {
		expect(
			classifyByAuthResults(header("mx.example.com; spf=softfail; dkim=neutral; dmarc=temperror")),
		).toBe("inbox");
	});

	it("is case-insensitive on the verdict values", () => {
		expect(
			classifyByAuthResults(header("mx.example.com; spf=FAIL; dkim=FAIL")),
		).toBe("spam");
	});
});
