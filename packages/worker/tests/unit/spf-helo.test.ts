import type { Header } from "postal-mime";
import { describe, expect, it } from "vitest";
import { RELAY_AUTHSERV_ID, summarizeAuthResults } from "../../src/spam-filter";

/**
 * The HELO name is whatever the sending server says it is, and the relay
 * writes it into Authentication-Results as it came. A name ending in
 * `.smtp.mailfrom=...` made the HELO section look like the envelope
 * sender's, and its pass stood in for the envelope sender's fail.
 */
const headers = (value: string): Header[] => [
	{
		key: "authentication-results",
		originalKey: "Authentication-Results",
		value,
	},
];

describe("SPF for the envelope sender", () => {
	it("is not read out of the HELO name", () => {
		const forged = headers(
			`${RELAY_AUTHSERV_ID}; spf=pass smtp.helo=relay.smtp.mailfrom=bank.example; spf=fail smtp.mailfrom=someone@bank.example`,
		);
		expect(summarizeAuthResults(forged).spf).toBe("fail");
	});

	it("is read where it is written", () => {
		const honest = headers(
			`${RELAY_AUTHSERV_ID}; spf=none smtp.helo=relay.example.org; spf=pass smtp.mailfrom=someone@example.org`,
		);
		expect(summarizeAuthResults(honest).spf).toBe("pass");
	});
});
