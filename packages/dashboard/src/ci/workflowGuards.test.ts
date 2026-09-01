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
	it("deploys only on a push to main", () => {
		expect(deploy).toContain(
			"if: github.ref == 'refs/heads/main' && github.event_name == 'push'",
		);
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
});
