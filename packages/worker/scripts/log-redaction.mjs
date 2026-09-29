/**
 * What the deploy log may not show, struck out by its shape.
 *
 * This repository's Actions logs are public, and wrangler decides for itself
 * what to print: the address it deployed to, and -- when the token is refused
 * -- the email of the account that owns it. One step filtered, the others did
 * not, so a token that stopped working would have put the owner's address in
 * a public log from whichever step met it first. Every step that runs
 * wrangler pipes its output through withhold.mjs, which applies this.
 *
 * By shape rather than by value: the values are not known here, and a
 * redaction that has to be configured is one that will one day not be.
 *
 * No `node:` imports, so the Workers test pool can test it.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WORKERS_DEV = /[A-Za-z0-9.-]+\.workers\.dev/g;

/** One line of wrangler's output, with every address taken out. */
export function withheld(line) {
	return line
		.replace(EMAIL, "(address withheld)")
		.replace(WORKERS_DEV, "(address withheld)");
}
