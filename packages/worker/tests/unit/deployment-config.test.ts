import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS on purpose: this module also runs under node
// from the deploy workflow, where there is nothing to compile it.
import {
	applyDeploymentConfig,
	setStringValue,
} from "../../scripts/deployment-config.mjs";
import { recoveryFromEmail } from "../../src/deployment-config";

/**
 * The values that belong to one deployment and no other.
 *
 * This repository is forked and deployed rather than copied, so these have to
 * be settable without editing a file this repository keeps changing. The
 * property that matters most is the boring one: a deployment that sets no
 * variables at all must come out byte for byte unchanged. That is the case
 * this repository's own production deployment is in.
 */

/** The shape of the real dev/wrangler.jsonc, comments and all. */
const CONFIG = `{
	"$schema": "node_modules/wrangler/config-schema.json",
	"compatibility_date": "2025-11-28",
	"main": "index.ts",
	"name": "email-explorer-ja",
	// A comment that has to survive.
	"vars": {
		"VAPID_PUBLIC_KEY": "BGU5original",
		"ACCOUNT_RECOVERY_FROM": "",
		"ROOT_ADMIN_EMAIL": ""
	},
	"r2_buckets": [
		{
			"binding": "BUCKET",
			"bucket_name": "email-explorer-ja",
			"preview_bucket_name": "email-explorer-ja"
		}
	],
	"durable_objects": {
		"bindings": [
			{
				"name": "MAILBOX",
				"class_name": "MailboxDO"
			}
		]
	}
}`;

const FORK = {
	WORKER_NAME: "email-explorer-fork",
	R2_BUCKET_NAME: "fork-mail",
	VAPID_PUBLIC_KEY: "BGforkkey",
	ACCOUNT_RECOVERY_FROM: "noreply@fork.example",
	ROOT_ADMIN_EMAIL: "operator+root@fork.example",
};

describe("applying a fork's own values", () => {
	it("sets every one of them", () => {
		const { source } = applyDeploymentConfig(CONFIG, FORK);
		expect(source).toContain('"name": "email-explorer-fork"');
		expect(source).toContain('"bucket_name": "fork-mail"');
		expect(source).toContain('"preview_bucket_name": "fork-mail"');
		expect(source).toContain('"VAPID_PUBLIC_KEY": "BGforkkey"');
		expect(source).toContain('"ACCOUNT_RECOVERY_FROM": "noreply@fork.example"');
		expect(source).toContain(
			'"ROOT_ADMIN_EMAIL": "operator+root@fork.example"',
		);
	});

	it("keeps the comments", () => {
		const { source } = applyDeploymentConfig(CONFIG, FORK);
		expect(source).toContain("// A comment that has to survive.");
	});

	it("still parses once the comments are stripped", () => {
		const { source } = applyDeploymentConfig(CONFIG, FORK);
		const json = JSON.parse(source.replace(/^\s*\/\/[^\n]*\n/gm, ""));
		expect(json.name).toBe("email-explorer-fork");
		expect(json.r2_buckets[0].bucket_name).toBe("fork-mail");
	});

	// The Durable Object binding has a "name" too, and it is not this one.
	it("does not touch the Durable Object binding's name", () => {
		const { source } = applyDeploymentConfig(CONFIG, FORK);
		expect(source).toContain('"name": "MAILBOX"');
	});

	it("says what it used", () => {
		const { applied } = applyDeploymentConfig(CONFIG, FORK);
		expect(applied.every((line: string) => line.includes(": set ("))).toBe(
			true,
		);
	});
});

describe("a deployment that configures nothing", () => {
	// The case this repository's own production deployment is in. Adding the
	// mechanism must not change a byte of what it deploys.
	it("is left exactly as it was", () => {
		expect(applyDeploymentConfig(CONFIG, {}).source).toBe(CONFIG);
	});

	/**
	 * GitHub hands a repository variable that was never created to a step as
	 * an empty string, so "" has to mean "not set". Treating it as a value
	 * would blank out the Worker's name on the first deploy after this
	 * mechanism landed.
	 */
	it("treats a blank or whitespace variable as unset", () => {
		const blank = {
			WORKER_NAME: "",
			R2_BUCKET_NAME: "   ",
			VAPID_PUBLIC_KEY: "",
			ACCOUNT_RECOVERY_FROM: "\t",
		};
		expect(applyDeploymentConfig(CONFIG, blank).source).toBe(CONFIG);
	});

	it("reports each one as a default", () => {
		const { applied } = applyDeploymentConfig(CONFIG, {});
		expect(applied.every((line: string) => line.includes(": default ("))).toBe(
			true,
		);
	});

	it("applies only the ones that are set", () => {
		const { source } = applyDeploymentConfig(CONFIG, {
			WORKER_NAME: "only-the-name",
		});
		expect(source).toContain('"name": "only-the-name"');
		expect(source).toContain('"bucket_name": "email-explorer-ja"');
	});
});

describe("a value that would not work", () => {
	// Better to fail here, naming the variable, than inside wrangler with the
	// offending string and no idea where it came from.
	it("refuses a Worker name Cloudflare will not accept", () => {
		expect(() =>
			applyDeploymentConfig(CONFIG, { WORKER_NAME: "Email Explorer" }),
		).toThrow(/WORKER_NAME/);
	});

	it("refuses a bucket name with an underscore", () => {
		expect(() =>
			applyDeploymentConfig(CONFIG, { R2_BUCKET_NAME: "fork_mail" }),
		).toThrow(/R2_BUCKET_NAME/);
	});

	it("refuses a from-address that is not one", () => {
		expect(() =>
			applyDeploymentConfig(CONFIG, { ACCOUNT_RECOVERY_FROM: "not an email" }),
		).toThrow(/ACCOUNT_RECOVERY_FROM/);
	});

	it("escapes a value rather than letting it break out of its string", () => {
		const { source } = applyDeploymentConfig(CONFIG, {
			VAPID_PUBLIC_KEY: 'a"b\\c',
		});
		expect(JSON.parse(source.replace(/^\s*\/\/[^\n]*\n/gm, "")).vars
			.VAPID_PUBLIC_KEY).toBe('a"b\\c');
	});
});

describe("setStringValue", () => {
	// If a key is renamed upstream, the deploy must fail rather than quietly
	// ship the previous deployment's bucket.
	it("fails when the key is gone", () => {
		expect(() => setStringValue(CONFIG, "no_such_key", "x")).toThrow(
			/no_such_key/,
		);
	});

	it("fails when a key it expects once appears twice", () => {
		expect(() => setStringValue(CONFIG, "name", "x")).toThrow(/once/);
	});

	it("finds the top-level one when asked for it", () => {
		expect(setStringValue(CONFIG, "name", "x", { topLevel: true })).toContain(
			'\t"name": "x"',
		);
	});
});

describe("where the recovery sender comes from", () => {
	const code = { config: { accountRecovery: { fromEmail: "code@example.com" } } };

	it("is off when neither source has one", () => {
		expect(recoveryFromEmail({} as never)).toBeUndefined();
	});

	it("uses the one in code when that is all there is", () => {
		expect(recoveryFromEmail(code as never)).toBe("code@example.com");
	});

	/**
	 * The precedence that makes forking work. Source code is what a fork
	 * inherits from this repository; the variable is what the fork itself
	 * sets. If code won, every fork would try to send its password resets as
	 * an address on a domain it does not own.
	 */
	it("prefers the deployment's own variable over the one in code", () => {
		expect(
			recoveryFromEmail({
				...code,
				ACCOUNT_RECOVERY_FROM: "noreply@fork.example",
			} as never),
		).toBe("noreply@fork.example");
	});

	// wrangler.jsonc carries the key with an empty value so a fork has
	// somewhere to put its own; empty must not shadow the one in code.
	it("ignores a blank variable", () => {
		expect(
			recoveryFromEmail({ ...code, ACCOUNT_RECOVERY_FROM: "  " } as never),
		).toBe("code@example.com");
	});
});
