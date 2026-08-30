import type { Header } from "postal-mime";

/**
 * Decides inbox vs. spam purely from the SPF/DKIM/DMARC verdicts Cloudflare
 * Email Routing (or any upstream relay) recorded in the Authentication-Results
 * header (RFC 8601) before the message reached this Worker. No network calls,
 * no cost, no added latency - just reading what was already verified.
 *
 * A message is filed as spam when nothing authenticated it AND the From
 * domain's own published policy says the sending host is not one of theirs.
 * Both halves are needed: one verifying DKIM signature is enough to keep a
 * message, however its SPF came out, because forwarding breaks SPF and leaves
 * DKIM intact.
 *
 * `spf=softfail` counts. It does not mean "this domain does not authenticate
 * its mail" -- that is `spf=none`, which is common among legitimate senders
 * and is left alone here. Softfail means the domain publishes an SPF record
 * and this host is not in it. A sender set up well enough to publish SPF,
 * signing nothing with DKIM, and sending from an address its own record
 * excludes, is misconfigured at best.
 *
 * The remaining verdicts are left alone deliberately: `none` (no record),
 * `neutral` (a record that declines to assert), and `temperror`/`permerror`
 * (the check itself did not complete) say nothing against the sender.
 *
 * The penalty is the spam folder, not rejection, so a wrong call here is
 * recoverable -- but only by someone who looks in it.
 */
/**
 * RFC 8601 gives each result its own `;`-separated section, and a relay may
 * record the same method more than once. Reading a verdict with one regex
 * over the whole header takes whichever happened to come first, which is not
 * the same as taking the one that matters.
 */
function resultSections(authResults: string): string[] {
	return authResults.split(";");
}

/**
 * SPF as evaluated for the envelope sender.
 *
 * A relay checks SPF twice and reports both, the HELO name first:
 *
 *   spf=none (no SPF records found for postmaster@host.invalid) smtp.helo=host.invalid;
 *   spf=softfail (domain of no-reply@example.com reports soft fail for 203.0.113.9) smtp.mailfrom=no-reply@example.com;
 *
 * Only the smtp.mailfrom result says anything about the sending domain.
 * Taking the first match let the HELO verdict stand in for it, so a hard fail
 * on the envelope sender was invisible whenever the HELO check reported
 * anything else -- which is the usual case, since HELO names rarely carry SPF.
 */
function spfVerdict(authResults: string): string | undefined {
	const withSpf = resultSections(authResults).filter((section) =>
		/\bspf=/i.test(section),
	);
	const section =
		withSpf.find((s) => /\bsmtp\.mailfrom=/i.test(s)) ?? withSpf[0];
	return /\bspf=(\w+)/i.exec(section ?? "")?.[1]?.toLowerCase();
}

/**
 * DKIM across every signature on the message.
 *
 * A message can carry several DKIM-Signature headers and the relay reports
 * one result per signature. One verifying signature authenticates the
 * message, so a pass anywhere is a pass -- reading the first result could
 * call a properly signed message failed and, paired with an SPF failure,
 * file real mail as spam. That is the outcome this module exists to avoid.
 */
function dkimVerdict(authResults: string): string | undefined {
	const verdicts = resultSections(authResults)
		.map((section) => /\bdkim=(\w+)/i.exec(section)?.[1]?.toLowerCase())
		.filter((verdict): verdict is string => verdict !== undefined);

	if (verdicts.length === 0) return undefined;
	if (verdicts.includes("pass")) return "pass";
	if (verdicts.includes("fail")) return "fail";
	return verdicts[0];
}

export function classifyByAuthResults(headers: Header[]): "inbox" | "spam" {
	const authResults = headers
		.filter((h) => h.key === "authentication-results")
		.map((h) => h.value)
		.join(" ");

	if (!authResults) return "inbox";

	const dmarc = /\bdmarc=(\w+)/i.exec(authResults)?.[1]?.toLowerCase();
	const spf = spfVerdict(authResults);
	const dkim = dkimVerdict(authResults);

	if (dmarc === "fail") return "spam";

	// An absent DKIM result is not an unknown: it means the message carried no
	// signature, so DKIM authenticated nothing. Treating it as unknown used to
	// let the worse case through -- a hard SPF failure with no signature at all
	// stayed in the inbox, while the same failure with a signature that merely
	// did not verify was filed as spam.
	const authenticated = dkim === "pass" || dmarc === "pass";
	const spfDisowned = spf === "fail" || spf === "softfail";
	if (spfDisowned && !authenticated) return "spam";

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
