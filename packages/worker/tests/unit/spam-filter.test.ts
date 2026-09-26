import { describe, expect, it } from "vitest";
import {
	classifyByAuthResults,
	isTrustedSelfDomainSender,
} from "../../src/spam-filter";

const header = (value: string) => [
	{
		key: "authentication-results",
		originalKey: "Authentication-Results",
		value,
	},
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
				header(
					"mx.example.com; spf=fail smtp.mailfrom=sender.com; dkim=fail header.i=@sender.com",
				),
			),
		).toBe("spam");
	});

	it("routes to inbox when only spf fails but dkim passes", () => {
		expect(
			classifyByAuthResults(
				header(
					"mx.example.com; spf=fail smtp.mailfrom=sender.com; dkim=pass header.i=@sender.com",
				),
			),
		).toBe("inbox");
	});

	it("routes to inbox when SPF says nothing against the sender", () => {
		// none = no record published, neutral = a record that declines to
		// assert, temperror/permerror = the check did not complete. None of
		// these is the domain disowning the sending host.
		for (const verdict of ["none", "neutral", "temperror", "permerror"]) {
			expect(
				classifyByAuthResults(
					header(
						`mx.example.com; spf=${verdict} smtp.mailfrom=no-reply@example.com; dmarc=none`,
					),
				),
			).toBe("inbox");
		}
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

	describe("nothing authenticated it and the domain disowns the host", () => {
		it("files a softfail with no DKIM signature as spam", () => {
			// The shape that arrived claiming to be a well-known brand: the
			// domain publishes SPF, this host is not in it, and nothing was
			// signed. Softfail is not "this domain does not authenticate" --
			// that is spf=none, checked above and left in the inbox.
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; dmarc=none header.from=example.com policy.dmarc=none; " +
							"spf=none (no SPF records found for postmaster@host.invalid) smtp.helo=host.invalid; " +
							"spf=softfail (domain of no-reply@example.com reports soft fail for 203.0.113.9) smtp.mailfrom=no-reply@example.com; " +
							"arc=none",
					),
				),
			).toBe("spam");
		});

		it("files a hard SPF fail with no DKIM signature as spam", () => {
			// This used to reach the inbox: with no dkim= result at all the
			// old rule compared "fail" against undefined and gave up. The same
			// failure with a signature that did not verify was filed as spam,
			// so the more suspicious message was the one that got through.
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; dmarc=none header.from=example.com; " +
							"spf=fail smtp.mailfrom=no-reply@example.com",
					),
				),
			).toBe("spam");
		});

		it("keeps a softfail whose DKIM signature verifies", () => {
			// What forwarding looks like: the relaying host is not in the
			// original domain's SPF, but the signature survived the trip. One
			// verifying signature is enough to keep the message.
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; dmarc=none header.from=example.com; " +
							"spf=softfail smtp.mailfrom=no-reply@example.com; " +
							"dkim=pass header.i=@example.com",
					),
				),
			).toBe("inbox");
		});

		it("keeps a sender that publishes no SPF record and signs nothing", () => {
			// The small-sender shape -- no SPF, no DKIM. Nothing here says the
			// message did not come from where it claims, so it stays.
			expect(
				classifyByAuthResults(
					header(
						"mx.example.com; dmarc=none header.from=example.com; " +
							"spf=none smtp.mailfrom=no-reply@example.com",
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

/**
 * What the sender writes cannot stand in for what the relay found.
 *
 * `=` is legal in an address, and every header below Cloudflare's is the
 * sender's own. Both used to be read as verdicts.
 */
describe("verdicts the sender wrote", () => {
	const auth = (...values: string[]) =>
		values.map((value) => ({
			key: "authentication-results",
			originalKey: "Authentication-Results",
			value,
		}));

	// The shape Cloudflare writes, for an envelope sender chosen to contain
	// the words.
	const forgedMailFrom =
		"mx.cloudflare.net; dkim=none; dmarc=none; spf=fail (mx.cloudflare.net: domain of dkim=pass@victim.example does not designate 203.0.113.9 as permitted sender) smtp.mailfrom=dkim=pass@victim.example;";

	it("does not read dkim=pass out of an envelope address", () => {
		expect(classifyByAuthResults(auth(forgedMailFrom))).toBe("spam");
	});

	it("does not read dmarc=pass out of an envelope address", () => {
		const value =
			"mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=dmarc=pass@victim.example";
		expect(classifyByAuthResults(auth(value))).toBe("spam");
		expect(
			isTrustedSelfDomainSender(
				auth(value),
				"boss@victim.example",
				"me@victim.example",
			),
		).toBe(false);
	});

	/**
	 * A comment is free text. One on the HELO result that mentions
	 * smtp.mailfrom made that result pass for the envelope sender's.
	 */
	it("does not take a comment for a property", () => {
		const value =
			"mx.cloudflare.net; spf=none (no record, see smtp.mailfrom=x.example) smtp.helo=h.example; spf=fail smtp.mailfrom=x.example; dkim=none";
		expect(classifyByAuthResults(auth(value))).toBe("spam");
	});

	it("does not split a result at a ; inside its comment", () => {
		const value =
			"mx.cloudflare.net; dkim=none (unsigned; dkim=pass was never here); spf=fail smtp.mailfrom=x.example";
		expect(classifyByAuthResults(auth(value))).toBe("spam");
	});

	/** The relay's header is the topmost; the sender's own come after it. */
	it("ignores an Authentication-Results header the sender put in the message", () => {
		const headers = auth(
			"mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=x.example",
			"forged.example; dkim=pass; dmarc=pass",
		);
		expect(classifyByAuthResults(headers)).toBe("spam");
		expect(
			isTrustedSelfDomainSender(headers, "a@x.example", "me@x.example"),
		).toBe(false);
	});

	it("still reads a real pass", () => {
		expect(
			classifyByAuthResults(
				auth(
					"mx.cloudflare.net; dkim=pass header.d=x.example; spf=fail smtp.mailfrom=x.example",
				),
			),
		).toBe("inbox");
	});
});
