// Reads the review session's stream-json transcript on stdin, prints the
// review, and exits 1 when there is none to print. The judgement is
// security-review-verdict.mjs; this only moves bytes. See security-review.sh.

import { reviewVerdict } from "./security-review-verdict.mjs";

let transcript = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) transcript += chunk;

const verdict = reviewVerdict(transcript);
if (verdict.ok) {
	console.log(verdict.review);
} else {
	console.error(`security review: FAILED -- ${verdict.reason}`);
	process.exit(1);
}
