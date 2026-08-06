import type { Header } from "postal-mime";

/**
 * Decides inbox vs. spam purely from the SPF/DKIM/DMARC verdicts Cloudflare
 * Email Routing (or any upstream relay) recorded in the Authentication-Results
 * header (RFC 8601) before the message reached this Worker. No network calls,
 * no cost, no added latency - just reading what was already verified.
 *
 * Deliberately conservative: anything short of a clear fail (missing header,
 * `none`/`neutral`/`softfail`/`temperror`/`permerror`, or only one of
 * spf/dkim failing) stays in the inbox. A false positive here silently
 * hides real mail, which is worse than an occasional spam message getting
 * through.
 */
export function classifyByAuthResults(headers: Header[]): "inbox" | "spam" {
	const authResults = headers
		.filter((h) => h.key === "authentication-results")
		.map((h) => h.value)
		.join(" ");

	if (!authResults) return "inbox";

	const dmarc = /\bdmarc=(\w+)/i.exec(authResults)?.[1]?.toLowerCase();
	const spf = /\bspf=(\w+)/i.exec(authResults)?.[1]?.toLowerCase();
	const dkim = /\bdkim=(\w+)/i.exec(authResults)?.[1]?.toLowerCase();

	if (dmarc === "fail") return "spam";
	if (spf === "fail" && dkim === "fail") return "spam";

	return "inbox";
}

function extractDomain(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * True only when the mail is a same-domain, DMARC-aligned message: the
 * From address shares the mailbox's own domain, and DMARC explicitly
 * *passed* (not merely "didn't fail"). DMARC pass proves SPF or DKIM is
 * aligned with the From domain, i.e. the message was genuinely sent through
 * that domain's own authorized mail infrastructure -- not just a spoofed
 * From header on a domain with no enforced DMARC policy.
 *
 * This is intentionally narrow: it exists only to exempt the business's own
 * transactional mail (e.g. verification emails sent from its own systems to
 * its own mailboxes) from the Claude content check, not to weaken detection
 * of confirmation-link-style phishing from any other domain -- that pattern
 * (payment/points/delivery "confirmation" links) is one of the most common
 * real spam patterns and must keep being evaluated normally.
 */
export function isTrustedSelfDomainSender(
	headers: Header[],
	fromAddress: string | undefined,
	mailboxId: string,
): boolean {
	if (!fromAddress) return false;

	const authResults = headers
		.filter((h) => h.key === "authentication-results")
		.map((h) => h.value)
		.join(" ");
	const dmarc = /\bdmarc=(\w+)/i.exec(authResults)?.[1]?.toLowerCase();
	if (dmarc !== "pass") return false;

	return extractDomain(fromAddress) === extractDomain(mailboxId);
}
