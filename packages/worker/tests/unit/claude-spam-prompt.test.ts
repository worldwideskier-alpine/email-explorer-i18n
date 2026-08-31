import type { Header } from "postal-mime";
import { describe, expect, it } from "vitest";
import { buildClassificationContent } from "../../src/claude-spam-filter";
import { summarizeAuthResults } from "../../src/spam-filter";

/**
 * What the second-stage classifier is actually handed.
 *
 * These assertions exist because the failure they guard is silent. A field
 * dropped on the way in does not raise anything: the API call succeeds, a
 * verdict comes back, and the message is filed. The only symptom is that the
 * classifier keeps answering NOT_SPAM to mail a person would recognise at a
 * glance -- which is how a message impersonating a card issuer reached the
 * inbox with the filter switched on and working.
 */

const header = (value: string): Header[] => [
	{
		key: "authentication-results",
		originalKey: "Authentication-Results",
		value,
	},
];

/**
 * The message that prompted all of this, reduced to its headers: a display
 * name naming a Japanese card issuer, over an address on a throwaway domain
 * that authenticates perfectly well because the sender owns it.
 */
const IMPERSONATION_AUTH =
	"i=1; mx.cloudflare.net; dkim=fail (verification failed) header.i=mail.saisoncard@mfdpfdyn.info header.s=mail header.b=ggbj5O4E; " +
	"dmarc=pass header.from=mfdpfdyn.info policy.dmarc=none; " +
	"spf=pass (domain of postmaster@mfdpfdyn.info designates 150.5.145.134 as permitted sender) smtp.helo=mfdpfdyn.info; " +
	"spf=pass (domain of mail.saisoncard@mfdpfdyn.info designates 150.5.145.134 as permitted sender) smtp.mailfrom=mail.saisoncard@mfdpfdyn.info; " +
	"arc=none smtp.remote-ip=150.5.145.134";

describe("summarizeAuthResults", () => {
	it("reports every verdict the first pass decided on", () => {
		expect(summarizeAuthResults(header(IMPERSONATION_AUTH))).toEqual({
			spf: "pass",
			dkim: "fail",
			dmarc: "pass",
			dmarcPolicy: "none",
		});
	});

	it("reads the DMARC policy from the parenthesised form too", () => {
		// Not every relay writes policy.dmarc=; some put it in the comment.
		expect(
			summarizeAuthResults(
				header(
					"mx.google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com; spf=pass smtp.mailfrom=example.com",
				),
			).dmarcPolicy,
		).toBe("reject");
	});

	it("does not mistake another field for the DMARC policy", () => {
		// "header.from=", "smtp.helo=" and "dis=NONE" all contain letters
		// followed by "=" and must not be read as p=.
		expect(
			summarizeAuthResults(
				header(
					"mx.example.com; dmarc=pass header.from=example.com; spf=pass smtp.helo=example.com",
				),
			).dmarcPolicy,
		).toBeUndefined();
	});

	it("reports nothing at all when the message carried no header", () => {
		expect(summarizeAuthResults([])).toEqual({});
	});

	it("carries over the same reading the first pass does", () => {
		// SPF from the envelope sender rather than the HELO name, and DKIM
		// counted as passed when any one signature verified. Reading these
		// differently here would put one story in the folder and another in
		// front of the classifier.
		expect(
			summarizeAuthResults(
				header(
					"mx.example.com; spf=none smtp.helo=host.invalid; spf=fail smtp.mailfrom=no-reply@example.com; " +
						"dkim=fail header.i=@old.example.com; dkim=pass header.i=@example.com",
				),
			),
		).toMatchObject({ spf: "fail", dkim: "pass" });
	});
});

describe("buildClassificationContent", () => {
	const impersonation = {
		subject: "【重要】ご利用確認のお願い",
		from: "mail.saisoncard@mfdpfdyn.info",
		fromName: "セゾンカード",
		auth: summarizeAuthResults(header(IMPERSONATION_AUTH)),
		text: "カードのご利用に不審な点がありました。",
	};

	// The defect this whole change exists for. Only the address used to be
	// passed, so the half of the From line that does the impersonating -- the
	// display name -- never reached the classifier at all.
	it("puts the display name in front of the classifier", () => {
		expect(buildClassificationContent(impersonation)).toContain(
			"From: セゾンカード <mail.saisoncard@mfdpfdyn.info>",
		);
	});

	it("tells the classifier what was and was not authenticated", () => {
		expect(buildClassificationContent(impersonation)).toContain(
			"Authentication: spf=pass dkim=fail dmarc=pass dmarc policy=none",
		);
	});

	it("keeps the subject and body", () => {
		const content = buildClassificationContent(impersonation);
		expect(content).toContain("Subject: 【重要】ご利用確認のお願い");
		expect(content).toContain("カードのご利用に不審な点がありました。");
	});

	it("marks where the email begins", () => {
		// The system prompt tells the model everything past the marker is data
		// rather than instructions. Without the marker that sentence points at
		// nothing.
		expect(buildClassificationContent(impersonation).startsWith("----\n")).toBe(
			true,
		);
	});

	it("gives just the address when there is no display name", () => {
		const content = buildClassificationContent({
			subject: "Invoice",
			from: "billing@supplier.example",
			text: "Attached.",
		});
		expect(content).toContain("From: billing@supplier.example\n");
		expect(content).not.toContain("<billing@supplier.example>");
	});

	it("does not repeat an address that is also the display name", () => {
		// Some senders put the address in both slots; "a@b <a@b>" reads as two
		// different things and is worth avoiding.
		const content = buildClassificationContent({
			subject: "Hello",
			from: "someone@example.com",
			fromName: "someone@example.com",
		});
		expect(content).toContain("From: someone@example.com\n");
		expect(content).not.toContain("<someone@example.com>");
	});

	// An absent Authentication-Results header is an absence, not a set of
	// failures. Printing a bare "Authentication:" would argue against a sender
	// that nothing was actually recorded about.
	it("omits the authentication line when nothing was recorded", () => {
		const content = buildClassificationContent({
			subject: "Hello",
			from: "someone@example.com",
			auth: summarizeAuthResults([]),
		});
		expect(content).not.toContain("Authentication:");
	});

	it("prints only the verdicts that exist", () => {
		const content = buildClassificationContent({
			subject: "Hello",
			from: "someone@example.com",
			auth: { spf: "pass" },
		});
		expect(content).toContain("Authentication: spf=pass\n");
	});

	it("falls back to the HTML body when there is no plain text", () => {
		const content = buildClassificationContent({
			subject: "Hello",
			from: "someone@example.com",
			html: "<p>Click <a href='http://x.invalid'>here</a></p>",
		});
		expect(content).toContain("Click here");
		expect(content).not.toContain("<p>");
	});
});
