import type { SpamCheckFailure } from "./claude-spam-filter";
import type { Env } from "./types";

/**
 * A second-stage check that got no answer is asked again later.
 *
 * The check fails open: a message it cannot classify goes to the inbox, which
 * is right -- holding mail back, or filing it as spam, would lose real mail
 * whenever Anthropic is out of reach. But it was asked once and never again,
 * so every message that met a refusal stayed unclassified for good. Measured
 * on the live mailbox on 2026-11-17: the check classified mail at 16:04 and
 * was refused at 17:10, `403 forbidden` from Cloudflare at KIX with no
 * `request-id` -- the call never reached the API -- after three attempts in
 * twenty seconds. A securities firm's name over a throwaway domain had reached
 * the inbox the day before, and nothing recorded whether it had been judged.
 *
 * So a message whose check could not be answered for a reason that comes and
 * goes is written down, and asked again on a widening schedule for a day
 * (RECHECK_DELAYS_MS, GIVE_UP_AFTER_MS). A SPAM answer moves it to spam and
 * takes its notification back, as the reader's own "spam" would, but only
 * while it is still in the inbox and its reader has not starred, answered
 * or forwarded it (MailboxDO.recheckSpam). The sender's rules are not touched: those are
 * the reader's.
 *
 * Where it runs is the point of the design. A mailbox's Durable Object alarm
 * is the night's (mailbox-night.ts), and two users of one alarm would each
 * have to tell its firing from the other's -- the night's own handler reads
 * a firing while a night is under way as the runtime having cut the night
 * off. A second cron would reach the Worker from before a rolled-back deploy
 * as a second nightly run, since triggers outlive the version that set them.
 * So the schedule lives in a Durable Object of its own, addressed by a name
 * no mailbox can have (RECHECK_OBJECT): its alarm is nobody else's, and code
 * from before this, rolled back to, finds no night stored there and returns.
 */

/** The Durable Object that keeps the schedule; never a mailbox's address. */
export const RECHECK_OBJECT = "SPAM-RECHECK";

/**
 * How long after the n-th unanswered attempt the next one is made: five
 * minutes after the first, widening to four hours, which then repeats. How
 * long a refusal lasts is not known; a widening schedule is cheap when it is
 * short and does not hammer when it is long.
 */
export const RECHECK_DELAYS_MS = [5, 15, 30, 60, 120, 240].map(
	(minutes) => minutes * 60_000,
);

/** A day after the first unanswered attempt, the message is given up on. */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/**
 * How far back the one-time pass over a mailbox's inbox reaches
 * (MailboxDO.offerRecentForRecheck): a week of messages delivered before
 * failed checks were written down, any of which may never have been judged.
 */
export const RECENT_MS = 7 * 24 * 60 * 60_000;

/** At most this many messages are asked about in one run of the alarm. */
export const RECHECKS_PER_RUN = 8;

/** Each message's recheck, its original read and its check, has this long. */
export const RECHECK_CALL_LIMIT_MS = 60_000;

/**
 * No new recheck is begun this long into a run. An alarm has fifteen minutes
 * of wall time, and a recheck can take its whole minute.
 */
export const RECHECK_RUN_MS = 8 * 60_000;

/** Given-up entries are kept this long as the record that they were. */
export const GIVEN_UP_KEPT_MS = 14 * 24 * 60 * 60_000;

/**
 * Whether a check that got no answer could get one later. A refusal in front
 * of the API, a rate limit, the API's own trouble and a network that did not
 * answer come and go; a key the API refuses, a workspace it will not serve
 * and an answer that was not a verdict -- at temperature 0, most likely the
 * same one again -- do not.
 */
export function asksAgainLater(failure: SpamCheckFailure | string): boolean {
	return (
		failure === "blocked" ||
		failure === "rateLimited" ||
		failure === "serverError" ||
		failure === "timeout" ||
		failure === "network" ||
		// Not one of the classifier's: the recheck itself could not finish
		// (the original could not be read, the call ran out of time).
		failure === "unfinished"
	);
}

/**
 * When to ask again after `attempts` unanswered attempts, the first of them
 * at `firstAt`; null once that would be past the day.
 */
export function nextRecheckAt(
	attempts: number,
	firstAt: number,
	now: number,
): number | null {
	const longest = RECHECK_DELAYS_MS[RECHECK_DELAYS_MS.length - 1] ?? 0;
	const delay =
		RECHECK_DELAYS_MS[
			Math.min(Math.max(attempts, 1), RECHECK_DELAYS_MS.length) - 1
		] ?? longest;
	const at = now + delay;
	return at - firstAt > GIVE_UP_AFTER_MS ? null : at;
}

/** What asking again about one message came to. */
export type RecheckOutcome =
	| {
			/** Nothing more to ask: answered, or no longer the question. */
			state: "settled";
			verdict?: "spam" | "inbox";
			moved?: boolean;
			why: string;
	  }
	| { state: "again"; failure: string }
	| { state: "give-up"; failure: string };

export function recheckObject(env: Pick<Env, "MAILBOX">) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(RECHECK_OBJECT));
}
