import { describe, expect, it } from "vitest";
import {
	classifyByAuthResults,
	isTrustedSelfDomainSender,
} from "../../src/spam-filter";

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

describe("isTrustedSelfDomainSender", () => {
	it("is true for a DMARC-aligned sender on the mailbox's own domain", () => {
		expect(
			isTrustedSelfDomainSender(
				header(
					"mx.example.com; spf=pass smtp.mailfrom=mailbox.example; dkim=pass header.i=@mailbox.example; dmarc=pass header.from=mailbox.example",
				),
				"noreply@mailbox.example",
				"owner@mailbox.example",
			),
		).toBe(true);
	});

	it("is case-insensitive on the domain comparison", () => {
		expect(
			isTrustedSelfDomainSender(
				header("mx.example.com; dmarc=pass header.from=Mailbox.example"),
				"noreply@MailBox.EXAMPLE",
				"owner@mailbox.example",
			),
		).toBe(true);
	});

	it("is false when the sender domain differs, even with dmarc=pass", () => {
		expect(
			isTrustedSelfDomainSender(
				header("mx.example.com; dmarc=pass header.from=other.com"),
				"noreply@other.com",
				"owner@mailbox.example",
			),
		).toBe(false);
	});

	it("is false when the domain matches but dmarc did not pass (e.g. missing/none)", () => {
		expect(
			isTrustedSelfDomainSender(
				header("mx.example.com; spf=pass; dkim=pass"),
				"noreply@mailbox.example",
				"owner@mailbox.example",
			),
		).toBe(false);
	});

	it("is false when there is no Authentication-Results header at all", () => {
		expect(
			isTrustedSelfDomainSender(
				[],
				"noreply@mailbox.example",
				"owner@mailbox.example",
			),
		).toBe(false);
	});

	it("is false when the From address is missing", () => {
		expect(
			isTrustedSelfDomainSender(
				header("mx.example.com; dmarc=pass header.from=mailbox.example"),
				undefined,
				"owner@mailbox.example",
			),
		).toBe(false);
	});
});
