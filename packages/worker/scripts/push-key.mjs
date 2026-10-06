/**
 * The key push notifications are signed with: whether the Worker needs one,
 * and a new one when it does.
 *
 * It used to be made by hand, kept as a GitHub secret and uploaded to the
 * Worker on every deploy -- so a copy of it lived on GitHub for good, every
 * deploy published one version more than it deployed, and a fork that skipped
 * the step had no push at all. Now the deploy makes one when the Worker has
 * none and hands it straight to the Worker's secrets, which nothing can read
 * back: not the API, not the dashboard, not this repository. A Worker that
 * already has one keeps it. A new key quietly stops every device subscribed
 * under the old one, so this errs, every time, on the side of leaving it.
 *
 * No `node:` imports here, so both halves are tested in the Workers pool;
 * the deploy step's reading and writing live in push-key-step.mjs, the split
 * night-check.mjs uses.
 */

/** The Worker secret that holds it (`env.VAPID_PRIVATE_KEY`). */
export const PUSH_KEY_SECRET = "VAPID_PRIVATE_KEY";

/**
 * What the deploy should do about the push key, from what
 * `wrangler secret list --format json` printed -- stderr folded in, through
 * withhold.mjs.
 *
 * - `generate`: the list was read, every entry in it names a secret, and none
 *   is the push key.
 * - `present`: it is there, and stays as it is.
 * - `unreadable`: anything else -- an error, an answer cut short, a shape
 *   this does not know, two lists where there should be one. The key is
 *   left alone then too: putting a key over one that exists stops every
 *   device subscribed under it, with nothing on any screen to say why, while
 *   a Worker that really has none is simply asked again on the next deploy.
 *
 * The list is looked for rather than taken whole, because wrangler prints
 * other things around it: on a runner's first run its telemetry notice went
 * to stdout ahead of everything else.
 *
 * @param {string} output
 * @returns {"generate" | "present" | "unreadable"}
 */
export function needsPushKey(output) {
	const lists = jsonArraysIn(String(output));
	if (lists.length !== 1) return "unreadable";
	const [list] = lists;
	const named = list.every(
		(entry) =>
			entry !== null &&
			typeof entry === "object" &&
			typeof entry.name === "string",
	);
	if (!named) return "unreadable";
	return list.some((entry) => entry.name === PUSH_KEY_SECRET)
		? "present"
		: "generate";
}

/**
 * Every JSON array in the text that starts on a line of its own, the way
 * wrangler prints one (`JSON.stringify(secrets, null, "  ")`, so `[]` when
 * there are none, and `[` ... `]` on lines of their own when there are).
 */
function jsonArraysIn(text) {
	const lines = text.split(/\r?\n/);
	const found = [];
	for (let start = 0; start < lines.length; start++) {
		if (!lines[start].trim().startsWith("[")) continue;
		for (let end = start; end < lines.length; end++) {
			if (!lines[end].trim().endsWith("]")) continue;
			let parsed;
			try {
				parsed = JSON.parse(lines.slice(start, end + 1).join("\n"));
			} catch {
				continue;
			}
			if (Array.isArray(parsed)) found.push(parsed);
			start = end;
			break;
		}
	}
	return found;
}

/**
 * What `node push-key-step.mjs <command>` prints, which is what the deploy
 * step reads: for `decide`, needsPushKey's word and a newline; for
 * `generate`, a new key as one line of JSON with nothing after it. Anything
 * else is a usage error and prints nothing on stdout.
 *
 * Here rather than in push-key-step.mjs so that the words the step compares
 * against are tested where they are produced: the step puts a key only on
 * "generate", so a wrapper that turned "unreadable" into "generate" would put
 * one over a key the list merely failed to show. That file only moves bytes.
 *
 * @param {string | undefined} command
 * @param {() => Promise<string>} input what arrived on stdin; read only by decide
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export async function pushKeyStep(command, input) {
	if (command === "decide") {
		return { stdout: `${needsPushKey(await input())}\n`, stderr: "", code: 0 };
	}
	if (command === "generate") {
		return {
			stdout: JSON.stringify(await generatePushKey()),
			stderr: "",
			code: 0,
		};
	}
	return {
		stdout: "",
		stderr: "usage: push-key-step.mjs decide | generate\n",
		code: 2,
	};
}

/**
 * A new push key: a P-256 key pair as the private JWK the Worker reads --
 * `d` to sign with, and `x` and `y`, the public point, which the Worker hands
 * browsers (`publicKeyOf`, routes/push.ts). Made the way
 * `npx @pushforge/builder vapid` makes one, which is the library the Worker
 * signs with.
 *
 * Checked rather than trusted: the deploy puts whatever this returns into the
 * Worker, and a key without its public point would send browsers the
 * checked-in public key, which pairs with nothing of the fork's.
 *
 * @returns {Promise<JsonWebKey & { alg: "ES256" }>}
 */
export async function generatePushKey() {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	for (const part of ["x", "y", "d"]) {
		if (typeof jwk[part] !== "string" || jwk[part] === "") {
			throw new Error(`the new push key has no ${part}`);
		}
	}
	if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
		throw new Error("the new push key is not a P-256 key");
	}
	return { alg: "ES256", ...jwk };
}
