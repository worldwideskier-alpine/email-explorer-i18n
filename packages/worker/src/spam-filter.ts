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
 * One result per `;`-separated section, read from where RFC 8601 puts it:
 * the `method=result` token at the start of the section, after comments are
 * taken out.
 *
 * It used to be a search for `dkim=pass` anywhere in the section, and the
 * rest of a section is the sender's to write. `=` is legal in an address, so
 * an envelope sender of `dkim=pass@example.com` put the words into the SPF
 * section's `smtp.mailfrom=` and inside its comment, and the search found
 * them: a hard SPF failure read as DKIM-authenticated and went to the inbox.
 * `raw` keeps the comments, which one relay uses for the DMARC policy.
 */
interface ResultSection {
	raw: string;
	bare: string;
}

/** Comments are parenthesised and nest (RFC 5322 CFWS); removed in one scan. */
function withoutComments(text: string): string {
	let depth = 0;
	let out = "";
	for (const ch of text) {
		if (ch === "(") depth += 1;
		else if (ch === ")" && depth > 0) depth -= 1;
		else if (depth === 0) out += ch;
	}
	return out;
}

/**
 * Split at the `;` between results, not at one inside a comment: split
 * naively, `dkim=none (x; dkim=pass)` became a section that began with
 * `dkim=pass`.
 */
function resultSections(authResults: string): ResultSection[] {
	const raws: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < authResults.length; i++) {
		const ch = authResults[i];
		if (ch === "(") depth += 1;
		else if (ch === ")" && depth > 0) depth -= 1;
		else if (ch === ";" && depth === 0) {
			raws.push(authResults.slice(start, i));
			start = i + 1;
		}
	}
	raws.push(authResults.slice(start));
	return raws.map((raw) => ({ raw, bare: withoutComments(raw) }));
}

function resultOf(section: ResultSection, method: string): string | undefined {
	return new RegExp(`^\\s*${method}\\s*=\\s*(\\w+)`, "i")
		.exec(section.bare)?.[1]
		?.toLowerCase();
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
	const withSpf = resultSections(authResults).filter(
		(section) => resultOf(section, "spf") !== undefined,
	);
	const section =
		withSpf.find((s) => /\bsmtp\.mailfrom=/i.test(s.bare)) ?? withSpf[0];
	return section && resultOf(section, "spf");
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
		.map((section) => resultOf(section, "dkim"))
		.filter((verdict): verdict is string => verdict !== undefined);

	if (verdicts.length === 0) return undefined;
	if (verdicts.includes("pass")) return "pass";
	if (verdicts.includes("fail")) return "fail";
	return verdicts[0];
}

function dmarcVerdict(authResults: string): string | undefined {
	for (const section of resultSections(authResults)) {
		const verdict = resultOf(section, "dmarc");
		if (verdict) return verdict;
	}
	return undefined;
}

/**
 * The DMARC policy the From domain publishes, as the relay recorded it.
 *
 * Two shapes are in the wild: Cloudflare writes `policy.dmarc=none`, other
 * relays write `dmarc=pass (p=NONE sp=NONE dis=NONE)`. Both are read from
 * the DMARC section alone -- `p=` appearing anywhere else in the header is
 * not this. The second shape is inside a comment, so this one reads `raw`.
 *
 * This is not used to file mail. `p=none` says only what the domain wants
 * done when DMARC *fails*, so it can never make a passing message worse.
 * It is here because it is worth something to a reader weighing the sender:
 * a domain registered for one campaign publishes SPF to get delivered and
 * stops there.
 */
function dmarcPolicy(authResults: string): string | undefined {
	const section = resultSections(authResults).find(
		(s) => resultOf(s, "dmarc") !== undefined,
	);
	if (!section) return undefined;
	const explicit = /\bpolicy\.dmarc=(\w+)/i.exec(section.bare)?.[1];
	return (explicit ?? /\bp=(\w+)/i.exec(section.raw)?.[1])?.toLowerCase();
}

export interface AuthSummary {
	spf?: string;
	dkim?: string;
	dmarc?: string;
	dmarcPolicy?: string;
}

/**
 * The Authentication-Results header the receiving relay wrote: the topmost.
 *
 * A relay adds its header above everything already in the message (RFC 8601
 * section 5), so the top one is Cloudflare's own. Every header was read
 * together before, and anybody can put an `Authentication-Results:
 * x; dkim=pass` in the message they send -- which then authenticated it.
 */
function joinAuthResults(headers: Header[]): string {
	return headers.find((h) => h.key === "authentication-results")?.value ?? "";
}

/**
 * The same four verdicts classifyByAuthResults decides on, handed out so the
 * second-stage classifier can weigh them too.
 *
 * The first pass answers one narrow question -- did this message really come
 * from the domain in the From header -- and then discarded its evidence. But
 * that evidence says more than the verdict does: a message whose DKIM
 * signature does not verify, on a domain that publishes no DMARC policy, is
 * a different proposition from one that is clean on every count, even though
 * both reach the inbox here.
 */
export function summarizeAuthResults(headers: Header[]): AuthSummary {
	const authResults = joinAuthResults(headers);
	if (!authResults) return {};
	return {
		spf: spfVerdict(authResults),
		dkim: dkimVerdict(authResults),
		dmarc: dmarcVerdict(authResults),
		dmarcPolicy: dmarcPolicy(authResults),
	};
}

export function classifyByAuthResults(headers: Header[]): "inbox" | "spam" {
	const authResults = joinAuthResults(headers);

	if (!authResults) return "inbox";

	const dmarc = dmarcVerdict(authResults);
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

	if (dmarcVerdict(joinAuthResults(headers)) !== "pass") return false;

	return extractDomain(fromAddress) === extractDomain(mailboxId);
}
