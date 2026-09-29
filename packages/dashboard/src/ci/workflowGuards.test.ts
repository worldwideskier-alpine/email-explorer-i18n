import { describe, expect, it } from "vitest";

/**
 * The properties of the deploy workflow that keep a pull request from
 * reaching production.
 *
 * This repository is public, `main` deploys on push, and anyone may open a
 * pull request. Nothing about that is wrong -- what would be wrong is a pull
 * request quietly changing the rules that make it safe. Those rules live in
 * four lines of YAML, they are easy to weaken by accident, and a diff that
 * weakens them looks like a diff that tidies them.
 *
 * So they are asserted here. This runs in `build-and-check`, which runs on
 * every pull request, so a change that removes any of them fails the pull
 * request that carries it -- before anyone has to notice it by reading.
 *
 * It cannot stop somebody who edits this file in the same pull request. It is
 * not meant to: nobody can merge here but the repository's owner. It is meant
 * so that the weakening has to be deliberate and visible, instead of arriving
 * inside a diff about something else.
 *
 * Read with import.meta.glob rather than node:fs for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const workflows = import.meta.glob<string>(
	"../../../../.github/workflows/*.yml",
	{
		query: "?raw",
		import: "default",
		eager: true,
	},
);

const deploy = Object.entries(workflows).find(([path]) =>
	path.endsWith("deploy.yml"),
)?.[1];

describe("the deploy workflow", () => {
	it("is where this test thinks it is", () => {
		// A rename would otherwise turn every assertion below into a silent pass.
		expect(deploy, "deploy.yml not found").toBeTruthy();
	});

	/**
	 * The line that keeps a pull request from deploying. Without it, opening a
	 * pull request against this repository would run the deploy job -- and the
	 * deploy job holds the Cloudflare token.
	 */
	it("deploys only from main, on a push or a run started by hand", () => {
		const guard = /^\s*deploy:\n\s*if: (.*)$/m.exec(deploy ?? "")?.[1] ?? "";
		expect(guard).toBe(
			"github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
		);
		expect(guard).not.toContain("pull_request");
	});

	/**
	 * `pull_request_target` runs the *base* branch's workflow with the pull
	 * request's code checked out, and with secrets. It is the single most
	 * common way a public repository leaks its credentials, and there is no
	 * use for it here.
	 */
	it("uses no trigger that would hand secrets to a pull request", () => {
		for (const [path, source] of Object.entries(workflows)) {
			expect(source, path).not.toContain("pull_request_target");
		}
	});

	/**
	 * The job that runs on pull requests must not carry any secret. Even
	 * without one, a fork's pull request does not receive them -- but a
	 * deployment that relied on that alone would be one settings change away
	 * from handing them over.
	 */
	it("keeps every secret out of the job that pull requests run", () => {
		const check = deploy?.slice(
			deploy.indexOf("build-and-check:"),
			deploy.indexOf("deploy:"),
		);
		expect(check).toBeTruthy();
		expect(check).not.toContain("secrets.");
	});

	/**
	 * The token goes to the steps that run wrangler and to nothing else. Set
	 * on the job, every step had it -- third-party actions and every install
	 * and build script included.
	 */
	it("hands the Cloudflare token only to the steps that use it", () => {
		const job = deploy?.slice(deploy.indexOf("\n  deploy:")) ?? "";
		const jobEnv = job.slice(
			job.indexOf("    env:"),
			job.indexOf("    steps:"),
		);
		expect(jobEnv).toBeTruthy();
		expect(jobEnv).not.toContain("CLOUDFLARE_API_TOKEN");

		const steps = job.split(/\n {6}- /).slice(1);
		const holding = steps.filter((step) =>
			step.includes("secrets.CLOUDFLARE_API_TOKEN"),
		);
		expect(holding.length).toBeGreaterThan(0);
		for (const step of holding) {
			expect(step, step.split("\n")[0]).toMatch(/wrangler|deploy-dev-worker/);
		}
	});

	/**
	 * wrangler prints the address it deployed to. A fork that has not set
	 * PRODUCTION_URL has nothing masking it, and the first account to register
	 * becomes root -- so a public log carrying the address, before its owner
	 * had registered, was an invitation to take the deployment. The output is
	 * filtered by the address's shape, and a failed deploy still fails.
	 */
	it("keeps the workers.dev address out of the deploy step's output", () => {
		const job = deploy?.slice(deploy.indexOf("\n  deploy:")) ?? "";
		const step =
			job
				.split(/\n {6}- /)
				.find((one) => one.startsWith("name: Deploy Worker")) ?? "";
		expect(step, "the Deploy Worker step").toContain("deploy-dev-worker");
		expect(step).toContain("set -o pipefail");
		const filter = /sed -E '(s\/[^']+)'/.exec(step)?.[1] ?? "";
		const [, pattern, replacement] = filter.split("/");
		const printed = "  https://my-worker.my-subdomain.workers.dev\n";
		expect(
			printed.replace(
				new RegExp(pattern.replaceAll("\\.", "\\."), "g"),
				replacement,
			),
		).not.toContain("workers.dev");
	});

	/**
	 * Every job reads the repository and nothing more. The job that checks
	 * had no permissions of its own and ran with the repository's default
	 * token, while running every install and build script there is; a token
	 * that could write could push to main, which deploys.
	 */
	/**
	 * Creating a bucket that is already there is an error, and the step
	 * printed it on every deploy: an [ERROR] in every log that meant nothing.
	 * It asks first now, and keeps what the question prints out of the log.
	 */
	it("creates the bucket only when it is not there", () => {
		const step =
			(deploy ?? "")
				.split(/\n {6}- /)
				.find((s) => s.startsWith("name: Ensure R2 bucket exists")) ?? "";
		const asked = step.indexOf("r2 bucket info");
		const created = step.indexOf("r2 bucket create");
		expect(asked, "no r2 bucket info").toBeGreaterThan(-1);
		expect(created).toBeGreaterThan(asked);
		expect(step).toMatch(/r2 bucket info "\$bucket" > \/dev\/null 2>&1/);
	});

	it("gives every job a token that can only read", () => {
		const top = /^permissions:\n((?: {2}.*\n)+)/m.exec(deploy ?? "")?.[1];
		expect(top?.trim()).toBe("contents: read");
		expect(deploy).not.toMatch(/:\s*write\b/);
		expect(deploy).not.toMatch(/permissions:\s*write-all/);
	});

	it("leaves no token behind in a checkout", () => {
		const checkouts = (deploy ?? "").split("uses: actions/checkout@").slice(1);
		expect(checkouts.length).toBeGreaterThan(0);
		for (const checkout of checkouts) {
			expect(checkout.split("\n      - ")[0]).toContain(
				"persist-credentials: false",
			);
		}
	});

	/** A tag can be moved to code nobody here has read; a commit cannot. */
	it("runs actions pinned to a commit", () => {
		for (const [path, source] of Object.entries(workflows)) {
			for (const [, action] of source.matchAll(/uses:\s*(\S+)/g)) {
				expect(action, path).toMatch(/@[0-9a-f]{40}$/);
			}
		}
	});
});
