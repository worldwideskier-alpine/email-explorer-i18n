/**
 * Reads `wrangler deployments status` output on stdin and writes
 * `version=<id>` for $GITHUB_OUTPUT, or nothing when no single version is
 * live. The next step compares it with the one the Worker says it is; see
 * liveVersionIn and workerVersionMismatch in deployment-check.mjs.
 */
import { liveVersionIn } from "./deployment-check.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const version = liveVersionIn(input);
if (version) process.stdout.write(`version=${version}\n`);
