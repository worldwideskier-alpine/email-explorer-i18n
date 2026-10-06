/**
 * The deploy step's half of push-key.mjs, which says why the deploy makes the
 * Worker's push key and when.
 *
 *   node push-key-step.mjs decide < what `wrangler secret list` printed
 *     prints one word: generate, present or unreadable (needsPushKey)
 *   node push-key-step.mjs generate
 *     prints a new key and nothing else, with no newline after it
 *
 * The key goes to stdout and nowhere else: no file, no log line. The step
 * holds it only to hand it to `wrangler secret put`, and only once it is
 * whole -- that command reads whatever arrives on its stdin, an empty one
 * included, and would put an empty key the next deploy then finds present.
 * workflowGuards.test.ts holds the step to that.
 */
import { generatePushKey, needsPushKey } from "./push-key.mjs";

const command = process.argv[2];
if (command === "decide") {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	process.stdout.write(`${needsPushKey(input)}\n`);
} else if (command === "generate") {
	process.stdout.write(JSON.stringify(await generatePushKey()));
} else {
	console.error("usage: push-key-step.mjs decide | generate");
	process.exit(2);
}
