/**
 * Copies stdin to stdout a line at a time, with every address taken out.
 * See log-redaction.mjs. Used as `wrangler ... 2>&1 | node withhold.mjs`,
 * under `set -o pipefail`, so wrangler's own exit status still decides the
 * step's.
 */
import { createInterface } from "node:readline";
import { withheld } from "./log-redaction.mjs";

for await (const line of createInterface({
	input: process.stdin,
	crlfDelay: Number.POSITIVE_INFINITY,
})) {
	process.stdout.write(`${withheld(line)}\n`);
}
