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
