/**
 * Puts a fork's own deployment values into `dev/wrangler.jsonc`.
 *
 * This repository is meant to be forked and deployed, not copied file by file.
 * The awkward part of that is a handful of values that belong to one
 * deployment and to no other: the Worker's name, its R2 bucket, its VAPID
 * public key, and the address account-recovery mail is sent from. They have to
 * live in `wrangler.jsonc`, which is also a file this repository keeps
 * changing -- so a fork that edited them by hand would collide with every
 * update it pulled.
 *
 * So they are edited here instead, at deploy time, from values the fork sets
 * once as GitHub repository variables. The checked-in file keeps working
 * defaults, which is what `wrangler dev` and the test pool read, and what a
 * deployment that sets no variables at all goes on using.
 *
 * The file is edited as text rather than parsed and re-serialised: it is
 * written to be read, and JSON.stringify would throw its comments away.
 *
 * No `node:` imports here, so the substitution can be tested in the Workers
 * pool alongside everything else. The file handling lives in
 * apply-deployment-config.mjs.
 */

/**
 * The deployment-specific values, in the order they are reported.
 *
 * `key` is the JSON key in wrangler.jsonc; `env` is the environment variable
 * (and therefore the repository variable) that supplies it.
 */
export const SETTINGS = [
	{
		env: "WORKER_NAME",
		keys: ["name"],
		topLevel: true,
		validate: validateResourceName,
		describe: "the Worker's name",
	},
	{
		env: "R2_BUCKET_NAME",
		// One bucket, named twice: wrangler wants a preview name as well, and
		// a fork with two names here would write its mail into one bucket and
		// read it from another.
		keys: ["bucket_name", "preview_bucket_name"],
		validate: validateResourceName,
		describe: "the R2 bucket holding mail and attachments",
	},
	{
		env: "VAPID_PUBLIC_KEY",
		keys: ["VAPID_PUBLIC_KEY"],
		describe: "the public half of the push-notification key pair",
	},
	{
		env: "ACCOUNT_RECOVERY_FROM",
		keys: ["ACCOUNT_RECOVERY_FROM"],
		validate: validateEmail,
		describe: "the address password-reset mail is sent from",
	},
	{
		env: "ROOT_ADMIN_EMAIL",
		keys: ["ROOT_ADMIN_EMAIL"],
		validate: validateEmail,
		describe: "the login address that may create and delete accounts",
	},
];

/**
 * Cloudflare's own rule for a Worker or bucket name. Checked here so a typo
 * fails while the message still says which variable to fix, rather than deep
 * inside wrangler with the offending value and no idea where it came from.
 */
function validateResourceName(value, env) {
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) {
		throw new Error(
			`${env}="${value}" is not usable: 3 to 63 characters, lowercase letters, digits and dashes, starting and ending with a letter or digit.`,
		);
	}
}

function validateEmail(value, env) {
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
		throw new Error(`${env}="${value}" is not an email address.`);
	}
}

/**
 * Replaces the value of one JSON string key.
 *
 * The key must appear exactly once, so a rename upstream turns into a failed
 * deploy rather than a silent no-op that ships the wrong bucket name. `name`
 * is the exception -- Durable Object bindings carry one too -- so it is
 * anchored to the top level, where it sits at a single tab of indentation.
 */
export function setStringValue(source, key, value, { topLevel = false } = {}) {
	const assignment = `("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`;
	const pattern = topLevel
		? new RegExp(`^(\\t)${assignment}`, "m")
		: new RegExp(assignment);

	const occurrences = source.match(new RegExp(assignment, "g")) ?? [];
	if (occurrences.length === 0) {
		throw new Error(`"${key}" is not a string setting in wrangler.jsonc.`);
	}
	if (!topLevel && occurrences.length > 1) {
		throw new Error(
			`"${key}" appears ${occurrences.length} times in wrangler.jsonc; it must appear once.`,
		);
	}
	if (!pattern.test(source)) {
		throw new Error(`"${key}" is not a top-level setting in wrangler.jsonc.`);
	}

	return source.replace(pattern, (_match, ...groups) =>
		topLevel
			? `${groups[0]}${groups[1]}${JSON.stringify(value)}`
			: `${groups[0]}${JSON.stringify(value)}`,
	);
}

/**
 * Applies every setting the environment supplies, and leaves the rest at the
 * checked-in default. A variable set to blank or to whitespace counts as not
 * set: GitHub hands an unset repository variable to a step as an empty string,
 * so treating "" as a value would blank out the defaults on every deployment
 * that has configured nothing.
 *
 * Returns the new source and a line per setting saying what was used, so the
 * deploy log shows what this deployment actually deployed.
 */
export function applyDeploymentConfig(source, env) {
	let result = source;
	const applied = [];

	for (const setting of SETTINGS) {
		const value = (env[setting.env] ?? "").trim();
		if (!value) {
			applied.push(`${setting.env}: default (${setting.describe})`);
			continue;
		}
		setting.validate?.(value, setting.env);
		for (const key of setting.keys) {
			result = setStringValue(result, key, value, {
				topLevel: setting.topLevel,
			});
		}
		applied.push(`${setting.env}: set (${setting.describe})`);
	}

	return { source: result, applied };
}
