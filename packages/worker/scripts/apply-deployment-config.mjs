#!/usr/bin/env node
/**
 * Rewrites dev/wrangler.jsonc in place with this deployment's own values,
 * taken from the environment. Run from the deploy workflow before building;
 * see deployment-config.mjs for why the values live outside the file.
 *
 * Editing a checked-in file is deliberate. The alternative -- a generated
 * config -- would mean `wrangler dev` and the test pool read something
 * different from what CI deploys. This way there is one file, the checked-in
 * defaults are what everyone develops against, and the runner's copy is
 * thrown away with the runner.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyDeploymentConfig } from "./deployment-config.mjs";

const CONFIG = fileURLToPath(new URL("../dev/wrangler.jsonc", import.meta.url));

const before = readFileSync(CONFIG, "utf8");
const { source, applied } = applyDeploymentConfig(before, process.env);

for (const line of applied) console.log(line);

if (source === before) {
	console.log("wrangler.jsonc unchanged.");
} else {
	writeFileSync(CONFIG, source);
	console.log("wrangler.jsonc updated.");
}
