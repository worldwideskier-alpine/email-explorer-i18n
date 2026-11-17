import type PostalMime from "postal-mime";
import type { ClassifyInput } from "./claude-spam-filter";
import { getClaudeApiKey, getSenderVerdictOverride } from "./mailbox-settings";
import {
	classifyByAuthResults,
	isTrustedSelfDomainSender,
	summarizeAuthResults,
} from "./spam-filter";
import type { Env } from "./types";

type ParsedEmail = Awaited<ReturnType<PostalMime["parse"]>>;

/**
 * Where a message goes before the second-stage check, and what that check is
 * asked when it is asked at all.
 *
 * One place, because two callers ask it: delivery (receiveEmail) and the
 * check asked again later for a message whose first check got no answer
 * (spam-recheck.ts). Asked separately, the two could come to read the same
 * message differently -- the one asked later seeing a sender rule the other
 * ignored, or leaving out the display name the first one sent.
 */
export interface SpamStages {
	/**
	 * The folder before the second stage, which is the folder for good when
	 * there is no `ask`.
	 */
	folder: "inbox" | "spam";
	/** What the second stage is asked; absent when it is not asked. */
	ask?: ClassifyInput;
}

export async function spamStagesOf(
	env: Pick<Env, "BUCKET">,
	mailboxId: string,
	parsedEmail: ParsedEmail,
): Promise<SpamStages> {
	// Highest precedence: the user has explicitly marked this exact sender
	// as spam or not-spam before (see PostEmailSpamVerdict). That's a
	// stronger signal than any automated check, so it short-circuits
	// everything below -- no auth check, no Claude call.
	//
	// With one exception, for "not spam". The rule is matched against the
	// From address, which whoever sends the message writes, so on its own it
	// let a forgery of an allowed sender into the inbox, notification and
	// all -- the one message the rule was never meant to admit. A DMARC fail
	// is what that forgery looks like: the From domain's owner published
	// how its mail is authenticated and this message is not. So a DMARC fail
	// is not overridden. Anything short of it still is, which is what the
	// rule is for -- a sender whose SPF is simply misconfigured.
	const verdict = await getSenderVerdictOverride(
		env,
		mailboxId,
		parsedEmail.from?.address,
	);
	const senderOverride =
		verdict === "inbox" &&
		summarizeAuthResults(parsedEmail.headers).dmarc === "fail"
			? undefined
			: verdict;

	const folder = senderOverride ?? classifyByAuthResults(parsedEmail.headers);

	// Second-stage check: only for mail that already passed SPF/DKIM/DMARC
	// (mail that failed it is spam regardless), and only when the mailbox
	// owner has opted in by configuring a Claude API key. No key -> skip
	// entirely, no API call made. Also skipped for DMARC-aligned mail sent
	// from the mailbox's own domain (e.g. the business's own transactional
	// systems) -- see isTrustedSelfDomainSender for why this is narrow and
	// doesn't weaken detection of confirmation-link-style phishing from
	// other domains.
	if (
		senderOverride ||
		folder !== "inbox" ||
		isTrustedSelfDomainSender(
			parsedEmail.headers,
			parsedEmail.from?.address,
			mailboxId,
		)
	) {
		return { folder };
	}
	const apiKey = await getClaudeApiKey(env, mailboxId);
	if (!apiKey) return { folder };
	return {
		folder,
		ask: {
			apiKey,
			subject: parsedEmail.subject || "",
			from: parsedEmail.from?.address || "",
			// The display name and the authentication verdicts both used to
			// be dropped here. Impersonation lives in the gap between the
			// two halves of the From line -- a household brand name over an
			// address on an unrelated domain -- and passing only the address
			// hid exactly that. The verdicts matter for the opposite reason:
			// this stage is reached only by mail that already passed them,
			// so without them the classifier cannot tell mail that passed
			// cleanly from mail that passed with a broken signature on a
			// domain that enforces nothing.
			fromName: parsedEmail.from?.name,
			auth: summarizeAuthResults(parsedEmail.headers),
			text: parsedEmail.text,
			html: parsedEmail.html,
		},
	};
}
