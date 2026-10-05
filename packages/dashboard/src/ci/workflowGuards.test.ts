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
 * So they are asserted here. This runs in `test-dashboard`, which runs on
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
	 * The jobs that run on pull requests must not carry any secret. Even
	 * without one, a fork's pull request does not receive them -- but a
	 * deployment that relied on that alone would be one settings change away
	 * from handing them over.
	 */
	it("keeps every secret out of the jobs that pull requests run", () => {
		const jobs = deploy?.slice(deploy.indexOf("\njobs:\n"));
		const checks = jobs?.slice(0, jobs.indexOf("\n  deploy:"));
		expect(checks).toMatch(/\n {2}lint-and-build:\n/);
		expect(checks).toMatch(/\n {2}test-worker:\n/);
		expect(checks).toMatch(/\n {2}test-dashboard:\n/);
		expect(checks).not.toContain("secrets.");
	});

	/**
	 * The checks run side by side, and the deploy waits for every one of
	 * them. A check left out of `needs` would still run -- and production
	 * would be deployed whatever it said.
	 */
	it("deploys only after every check has passed", () => {
		const needs = /^\s*deploy:\n(?:.*\n)*?\s*needs: \[(.*)\]$/m.exec(
			deploy ?? "",
		)?.[1];
		expect(needs?.split(/,\s*/).sort()).toEqual([
			"lint-and-build",
			"test-dashboard",
			"test-worker",
		]);
		const step = (job: string) => {
			const from = (deploy ?? "").slice(
				(deploy ?? "").indexOf(`\n  ${job}:\n`) + 1,
			);
			const next = from.slice(1).search(/\n {2}[a-z-]+:\n/);
			return next < 0 ? from : from.slice(0, next + 1);
		};
		expect(step("lint-and-build")).toMatch(/run: pnpm run lint\n/);
		expect(step("lint-and-build")).toMatch(/run: pnpm run build\n/);
		expect(step("test-worker")).toMatch(/run: pnpm test-worker\n/);
		expect(step("test-dashboard")).toMatch(/run: pnpm test-dashboard\n/);
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
	 * wrangler decides what to print: the address it deployed to, and -- when
	 * a token is refused -- the email of the account that owns it. A fork that
	 * has not set PRODUCTION_URL has nothing masking the first, and the first
	 * account to register becomes root; the second is somebody's address in a
	 * public log. Only one step filtered the one and one the other. Now every
	 * command a token-holding step runs goes through withhold.mjs (tested in
	 * the worker's log-redaction.test.ts), except one whose output is thrown
	 * away, and under pipefail so that a failed wrangler still fails.
	 */
	it("keeps every address out of what wrangler prints", () => {
		const job = deploy?.slice(deploy.indexOf("\n  deploy:")) ?? "";
		const steps = job
			.split(/\n {6}- /)
			.filter((step) => step.includes("secrets.CLOUDFLARE_API_TOKEN"));
		expect(steps.length).toBeGreaterThanOrEqual(4);
		for (const step of steps) {
			const name = step.split("\n")[0];
			const script = step
				.slice(step.indexOf("run: |"))
				.replace(/\\\n\s*/g, " ");
			const commands = script
				.split("\n")
				.filter((line) => !line.trim().startsWith("#"))
				.filter((line) => /wrangler|deploy-dev-worker/.test(line));
			expect(commands.length, name).toBeGreaterThan(0);
			for (const command of commands) {
				if (/> \/dev\/null 2>&1/.test(command)) continue;
				expect(command, name).toMatch(/2>&1\s+\|\s+node \S*withhold\.mjs/);
				// Its failure matters unless it says it does not.
				if (!/\|\| true/.test(command)) {
					expect(script, name).toContain("set -o pipefail");
				}
			}
		}
	});

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

	/**
	 * Every job reads the repository and nothing more. The job that checks
	 * had no permissions of its own and ran with the repository's default
	 * token, while running every install and build script there is; a token
	 * that could write could push to main, which deploys.
	 */
	/**
	 * A hung install or test held a runner for GitHub's six hours; a whole
	 * run takes minutes.
	 */
	it("gives every job an end", () => {
		const section = (deploy ?? "").slice((deploy ?? "").indexOf("\njobs:\n"));
		const jobs = section.split(/\n {2}(?=[a-z-]+:\n)/).slice(1);
		expect(jobs.length).toBeGreaterThanOrEqual(2);
		for (const job of jobs) {
			expect(job, job.split("\n")[0]).toMatch(/\n {4}timeout-minutes: \d+/);
		}
	});

	/**
	 * The page and its bundle prove the assets only. The check is handed the
	 * version wrangler says is live, and asks the Worker whether it is that
	 * one -- and the bucket step asks the config for the bucket, rather than
	 * repeating a default of its own.
	 */
	it("asks the Worker for the version it published, and the config for the bucket", () => {
		const step = (name: string) =>
			(deploy ?? "")
				.split(/\n {6}- /)
				.find((one) => one.startsWith(`name: ${name}`)) ?? "";
		expect(step("Report the version that is live")).toContain("id: live");
		expect(step("Report the version that is live")).toContain(
			"live-version.mjs",
		);
		expect(step("Check the deployment serves this build")).toContain(
			"EXPECTED_WORKER_VERSION: ${{ steps.live.outputs.version }}",
		);
		expect(step("Ensure R2 bucket exists")).toContain(
			'bucket="$(node ../scripts/bucket-name.mjs)"',
		);
		expect(step("Ensure R2 bucket exists")).not.toMatch(/R2_BUCKET_NAME:-/);
	});

	it("gives every job a token that can only read", () => {
		for (const [path, source] of Object.entries(workflows)) {
			const top = /^permissions:\n((?: {2}.*\n)+)/m.exec(source)?.[1];
			expect(top?.trim(), path).toBe("contents: read");
			expect(source, path).not.toMatch(/:\s*write\b/);
			expect(source, path).not.toMatch(/permissions:\s*write-all/);
		}
	});

	it("leaves no token behind in a checkout", () => {
		for (const [path, source] of Object.entries(workflows)) {
			const checkouts = source.split("uses: actions/checkout@").slice(1);
			expect(checkouts.length, path).toBeGreaterThan(0);
			for (const checkout of checkouts) {
				expect(checkout.split("\n      - ")[0], path).toContain(
					"persist-credentials: false",
				);
			}
		}
	});

	/**
	 * A deploy that fails after it went live is put back. The version to go
	 * back to has to be read before the deploy -- afterwards it is gone from
	 * `deployments status` -- and the step that uses it has to run on a
	 * failure, which a step without `failure()` never does.
	 */
	it("rolls a failed deploy back to the version live before it", () => {
		const steps = (deploy ?? "").split(/\n {6}- /);
		const at = (name: string) =>
			steps.findIndex((one) => one.startsWith(`name: ${name}`));
		const before = steps[at("Note the version that is live now")] ?? "";
		expect(before).toContain("id: before");
		expect(before).toContain("live-version.mjs");
		expect(at("Note the version that is live now")).toBeLessThan(
			at("Deploy Worker"),
		);
		const back = steps.at(-1) ?? "";
		expect(back).toMatch(
			/^name: Roll back to the version that was live before/,
		);
		expect(back).toContain(
			"if: failure() && steps.before.outputs.version != ''",
		);
		expect(back).toContain('wrangler rollback "$BEFORE"');
		expect(back).toContain("BEFORE: ${{ steps.before.outputs.version }}");
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

const nightCheck = Object.entries(workflows).find(([path]) =>
	path.endsWith("night-check.yml"),
)?.[1];

const wrangler = Object.values(
	import.meta.glob<string>("../../../worker/dev/wrangler.jsonc", {
		query: "?raw",
		import: "default",
		eager: true,
	}),
)[0];

/**
 * The evening check of the nightly run (scripts/night-check.mjs). It holds
 * the Cloudflare token and writes into a public log, and it is only worth
 * anything if it asks after the run has had its time.
 */
describe("the night check workflow", () => {
	it("is where this test thinks it is", () => {
		expect(nightCheck, "night-check.yml not found").toBeTruthy();
		expect(wrangler, "wrangler.jsonc not found").toBeTruthy();
	});

	it("asks half an hour after the Worker's own cron", () => {
		const cron = /"crons":\s*\["(\d+) (\d+) \* \* \*"\]/.exec(wrangler ?? "");
		const asks = /cron: '(\d+) (\d+) \* \* \*'/.exec(nightCheck ?? "");
		expect(cron, "the Worker's cron is not a daily one").toBeTruthy();
		expect(asks, "the check's cron is not a daily one").toBeTruthy();
		const minutes = (m: RegExpExecArray) => Number(m[2]) * 60 + Number(m[1]);
		expect(
			minutes(asks as RegExpExecArray) - minutes(cron as RegExpExecArray),
		).toBe(30);
	});

	it("hands the token only to the step that reads, and filters what it prints", () => {
		const steps = (nightCheck ?? "").split(/\n {6}- /).slice(1);
		const holding = steps.filter((step) =>
			step.includes("secrets.CLOUDFLARE_API_TOKEN"),
		);
		expect(holding).toHaveLength(1);
		const step = (holding[0] ?? "").replace(/\\\n\s*/g, " ");
		expect(step).toMatch(/^name: Read last night's run/);
		expect(step).toContain("set -o pipefail");
		expect(step).toMatch(/check-night\.mjs 2>&1\s+\|\s+node \S*withhold\.mjs/);
		const jobEnv = (nightCheck ?? "").slice(
			(nightCheck ?? "").indexOf("    env:"),
			(nightCheck ?? "").indexOf("    steps:"),
		);
		expect(jobEnv).not.toContain("secrets.");
	});
});
