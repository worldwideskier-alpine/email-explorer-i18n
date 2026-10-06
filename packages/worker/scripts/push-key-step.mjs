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
 *
 * What is printed is decided in pushKeyStep, where it is tested; this file
 * only reads stdin and writes what it is given, and push-key.test.ts holds
 * that it decides nothing of its own.
 */
import { pushKeyStep } from "./push-key.mjs";

process.stdin.setEncoding("utf8");
const { stdout, stderr, code } = await pushKeyStep(
	process.argv[2],
	async () => {
		let input = "";
		for await (const chunk of process.stdin) input += chunk;
		return input;
	},
);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
