import { describe, expect, it } from "vitest";

/**
 * The key scans of .claude/pre-merge-check.sh, and the file that lets
 * findings in main's own history through them.
 *
 * Two upstream values sit in this repository's history: upstream's
 * ROADMAP.md, imported whole and deleted since. The history is not rewritten
 * (upstream's main still has the file), so the scan of the whole history
 * would stop every merge on them; .claude/gitleaks-known-history lets those
 * two through, by commit. What has to stay true is that nothing a pull
 * request carries can let its *own* key through the same way -- not a line
 * in that file, not a .gitleaksignore or .gitleaks.toml at the root, not a
 * "gitleaks:allow" on the line, not a .gitattributes or a NUL byte that makes
 * git print "Binary files differ". Each was measured doing exactly that.
 *
 * The script is a few lines of shell, and a diff that undoes one of them
 * looks like a diff that tidies it. As with workflowGuards.test.ts, this
 * cannot stop a pull request that edits it in the same change; it makes that
 * change deliberate and visible.
 *
 * Read with import.meta.glob rather than node:fs for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const files = import.meta.glob<string>(
	[
		"../../../../.claude/pre-merge-check.sh",
		"../../../../.claude/gitleaks-known-history",
	],
	{ query: "?raw", import: "default", eager: true },
);

const read = (name: string) =>
	Object.entries(files).find(([path]) =>
		path.endsWith(`/.claude/${name}`),
	)?.[1];

const script = read("pre-merge-check.sh") ?? "";
const known = read("gitleaks-known-history") ?? "";

/** The script's own lines, without its comments. */
const code = script
	.split("\n")
	.filter((line) => !line.trim().startsWith("#"))
	.join("\n");

/** Every line of the script that runs gitleaks, continuations joined. */
const gitleaksRuns = code
	.replace(/\\\n\s*/g, " ")
	.split("\n")
	.filter((line) => /\bgitleaks git\b/.test(line));

/** Every call of the script's scan(), by the name of its pass. */
const passes = Object.fromEntries(
	[...code.matchAll(/^scan (\S+) (.*)$/gm)].map(([, name, rest]) => [
		name,
		rest,
	]),
);

/**
 * A commit fingerprint: <40-hex commit>:<path>:<rule>:<line>. gitleaks also
 * takes <path>:<rule>:<line>, which lets that file and line through in every
 * commit -- the ones being merged included.
 */
const FINGERPRINT = /^([0-9a-f]{40}):[^:]+:[a-z0-9-]+:[0-9]+$/;

/** What gitleaks reads as an entry: it trims a line, then skips "#" and "". */
const entries = known
	.split("\n")
	.map((line, at) => ({ line, at }))
	.filter(({ line }) => line.trim() !== "" && !line.trim().startsWith("#"));

describe("the pre-merge key scans", () => {
	it("are where this test thinks they are", () => {
		// A rename would otherwise turn every assertion below into a silent pass.
		expect(script, "pre-merge-check.sh not found").toBeTruthy();
		expect(known, "gitleaks-known-history not found").toBeTruthy();
	});

	it("scan the commits being merged without the registered history", () => {
		expect(passes.range).toBe('"${base}..HEAD"');
		expect(passes.range).not.toMatch(/(^|\s)(-i|--gitleaks-ignore-path)\b/);
	});

	/**
	 * -m, because a merge commit has no diff in git log without it: a key
	 * that only a conflict's resolution put in was never read.
	 */
	it("scan all of HEAD's history, merges included, less the registered file", () => {
		expect(passes.full).toBe('"-m HEAD" -i "$known"');
		expect(code).toContain("known=.claude/gitleaks-known-history\n");
	});

	it("run gitleaks once, in the function both passes share", () => {
		expect(Object.keys(passes).sort()).toEqual(["full", "range"]);
		expect(gitleaksRuns).toHaveLength(1);
		const run = gitleaksRuns[0] ?? "";
		expect(run).toContain('--log-opts="--text --no-textconv ${opts}"');
		expect(run).toContain("--ignore-gitleaks-allow");
		expect(run).toContain("--redact");
		expect(run).toContain('"$@" .');
		// -v prints the author's name and address beside each finding.
		expect(run).not.toMatch(/\s(-v|--verbose)\b/);
		expect(run).not.toMatch(/\s(-c|--config|-b|--baseline-path)\b/);
	});

	it("print a finding as its rule, file, line and commit, and nothing else of it", () => {
		expect(code).toContain("--report-format json");
		const printed = [...code.matchAll(/\$\{f\.(\w+)\}/g)].map(([, f]) => f);
		expect(printed.sort()).toEqual(["Commit", "File", "RuleID", "StartLine"]);
	});

	it("read the whole history, from a base that exists", () => {
		const first = code.indexOf("gitleaks git");
		const unshallow = code.indexOf("git fetch --quiet --unshallow");
		expect(code).toContain(
			'if [ "$(git rev-parse --is-shallow-repository)" = true ]; then',
		);
		expect(unshallow).toBeGreaterThan(-1);
		expect(unshallow).toBeLessThan(first);
		expect(code).toContain(
			'git rev-parse --verify --quiet "${base}^{commit}" > /dev/null || {',
		);
	});

	/**
	 * gitleaks reads all of these on every scan, whatever -i is given, so any
	 * one of them would have let the pull request's own commits through too.
	 */
	it("refuse every other way gitleaks could be told to look away", () => {
		expect(code).toContain("unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML\n");
		expect(code).toContain("for ignored in .gitleaksignore .gitleaks.toml; do");
		const loop = code.slice(code.indexOf("for ignored in"));
		expect(loop.slice(0, loop.indexOf("done"))).toContain("exit 1");
	});

	it("accept only a commit fingerprint, and only of a commit on the base", () => {
		const accepted = /^fingerprint='(.*)'$/m.exec(code)?.[1];
		expect(accepted).toBe(FINGERPRINT.source);
		expect(code).toContain('done < "$known"');
		expect(code).toContain('git merge-base --is-ancestor "$commit" "$base"');
		// The last line of a file without a final newline is read too.
		expect(code).toContain('while IFS= read -r line || [ -n "$line" ]; do');
	});
});

describe("the registered history", () => {
	it("names each finding by its commit", () => {
		for (const { line, at } of entries) {
			expect(line, `line ${at + 1}`).toMatch(FINGERPRINT);
		}
	});

	/**
	 * A fingerprint says where, never why. The reason is what the owner
	 * decided on, and the line above is where the next reader looks for it.
	 */
	it("gives every group of fingerprints its reason right above it", () => {
		const lines = known.split("\n");
		for (const { at } of entries) {
			const above = lines[at - 1] ?? "";
			if (FINGERPRINT.test(above)) continue;
			expect(above.startsWith("#"), `line ${at + 1}`).toBe(true);
		}
	});
});
