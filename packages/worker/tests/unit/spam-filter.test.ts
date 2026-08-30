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

	describe("picks the result that matters, not the first one printed", () => {
		it("reads SPF for the envelope sender, not for the HELO name", () => {
			// The shape Cloudflare Email Routing produces: the HELO check first,
			// the envelope sender second. Only the second concerns the sending
			// domain, and here it is the one that hard-fails.
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; dmarc=none header.from=example.com policy.dmarc=none; " +
							"spf=none (no SPF records found for postmaster@host.invalid) smtp.helo=host.invalid; " +
							"spf=fail (domain of no-reply@example.com does not designate 203.0.113.9) smtp.mailfrom=no-reply@example.com; " +
							"dkim=fail header.i=@example.com",
					),
				),
			).toBe("spam");
		});

		it("still reads SPF when only a HELO result is recorded", () => {
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; spf=fail smtp.helo=host.invalid; dkim=fail header.i=@example.com",
					),
				),
			).toBe("spam");
		});

		it("treats the message as signed when any DKIM signature passes", () => {
			// Two signatures, the failing one printed first. One verifying
			// signature authenticates the message, so this is real mail.
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; spf=fail smtp.mailfrom=no-reply@example.com; " +
							"dkim=fail header.i=@old.example.com; dkim=pass header.i=@example.com",
					),
				),
			).toBe("inbox");
		});

		it("counts DKIM as failed only when no signature passed", () => {
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; spf=fail smtp.mailfrom=no-reply@example.com; " +
							"dkim=neutral header.i=@old.example.com; dkim=fail header.i=@example.com",
					),
				),
			).toBe("spam");
		});
	});

	describe("the softfail-plus-no-DKIM shape stays in the inbox", () => {
		it("keeps a spoofed-looking message whose SPF only softfails", () => {
			// Deliberate: softfail is not a fail, and hiding real mail is the
			// worse error. Recorded so that changing it is a decision, not a
			// side effect.
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; dmarc=none header.from=example.com policy.dmarc=none; " +
							"spf=none (no SPF records found for postmaster@host.invalid) smtp.helo=host.invalid; " +
							"spf=softfail (domain of no-reply@example.com reports soft fail for 203.0.113.9) smtp.mailfrom=no-reply@example.com; " +
							"arc=none",
					),
				),
			).toBe("inbox");
		});
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
