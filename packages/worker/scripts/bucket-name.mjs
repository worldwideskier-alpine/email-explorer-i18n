/**
 * Prints the R2 bucket's name as dev/wrangler.jsonc has it, after
 * apply-deployment-config.mjs has run. The deploy's bucket step asks this
 * rather than repeating the default: it had one of its own, which a rename
 * of the checked-in default would have left behind -- creating one bucket and
 * deploying against another -- and it did not trim the variable the way the
 * config does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringValueOf } from "./deployment-config.mjs";

const CONFIG = fileURLToPath(new URL("../dev/wrangler.jsonc", import.meta.url));
process.stdout.write(
	`${stringValueOf(readFileSync(CONFIG, "utf8"), "bucket_name")}\n`,
);
