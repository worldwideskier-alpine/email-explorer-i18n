import { describe, expect, it } from "vitest";

/**
 * The key scans of .claude/pre-merge-check.sh, and the file that lets
 * findings in main's own history through them.
 *
 * Two upstream values sit in this repository's history: upstream's
 * ROADMAP.md, imported whole and deleted since. The history is not rewritten
 * (upstream's main still has the file), so the scan of the whole history
 * would stop every merge on them; .claude/gitleaks-known-history lets those
 * two through, by commit. What has to stay true is that none of the ways a
 * pull request was measured letting its *own* key through works again: a
 * line in that file, a .gitleaksignore or .gitleaks.toml at the root, a
 * "gitleaks:allow" on the line, a .gitattributes or a NUL byte that makes git
 * print "Binary files differ", and anything that makes git write to stderr,
 * at which gitleaks stops reading and passes what it read. Nor the runner's
 * own git config: color.ui and log.diffMerges each blinded a scan.
 *
 * That is not every way. gitleaks' default config skips lock files, images,
 * node_modules and lines some rules accept, whatever it is given; AGENTS.md
 * says so, and review is what catches a key put there.
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

/** The body of scan(), which both passes run. */
const scanBody = (() => {
	const start = code.indexOf("scan() {");
	return start < 0 ? "" : code.slice(start, code.indexOf("\n}\n", start));
})();

/** The node -e that prints a finding, its whitespace collapsed. */
const printer = /node -e '([^']*)'/
	.exec(code)?.[1]
	?.replace(/\s+/g, " ")
	.trim();

/**
 * All of it, because a printer can leak without naming a new field: a
 * second read of the report, or the whole finding handed to console.error,
 * which printed the author's address (measured).
 */
const PRINTER = [
	'const fs = require("node:fs");',
	"const path = process.argv[1];",
	"if (!fs.existsSync(path)) {",
	'console.error("gitleaks stopped before it wrote a report");',
	"process.exit();",
	"}",
	'for (const f of JSON.parse(fs.readFileSync(path, "utf8"))) {',
	"console.error(`${f.RuleID} ${f.File}:${f.StartLine} in ${f.Commit}`);",
	"}",
].join(" ");

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
		expect(scanBody, "scan() not found").toContain("gitleaks git");
		expect(printer, "the printer not found").toBeTruthy();
	});

	it("scan the commits being merged without the registered history", () => {
		expect(passes.range).toBe('"${base}..HEAD"');
		expect(passes.range).not.toMatch(/(^|\s)(-i|--gitleaks-ignore-path)\b/);
	});

	/**
	 * A merge commit has no diff in git log without --diff-merges, so a key
	 * that only a conflict's resolution put in was never read. Not -m, which
	 * takes its format from log.diffMerges: set to combined, it read nothing
	 * of the merge again.
	 */
	it("scan all of HEAD's history, merges included, less the registered file", () => {
		expect(passes.full).toBe('"--diff-merges=separate HEAD" -i "$known"');
		expect(code).toContain("known=.claude/gitleaks-known-history\n");
	});

	it("run gitleaks once, in the function both passes share", () => {
		expect(Object.keys(passes).sort()).toEqual(["full", "range"]);
		expect(gitleaksRuns).toHaveLength(1);
		const run = gitleaksRuns[0] ?? "";
		expect(scanBody.replace(/\\\n\s*/g, " ")).toContain(run.trim());
		// --no-color against color.ui=always; --text and --no-textconv against
		// "Binary files differ".
		expect(scanBody).toContain(
			'local name="$1" opts="--no-color --text --no-textconv $2" said\n',
		);
		expect(run).toContain('--log-opts="${opts}"');
		expect(run).toContain("--ignore-gitleaks-allow");
		expect(run).toContain("--redact");
		expect(run).toContain('"$@" .');
		// -v prints the author's name and address beside each finding.
		expect(run).not.toMatch(/\s(-v|--verbose)\b/);
		expect(run).not.toMatch(/\s(-c|--config|-b|--baseline-path)\b/);
		expect(run).not.toMatch(/--exit-code\b/);
	});

	/**
	 * gitleaks stops reading git's output at the first line git writes to
	 * stderr and reports what it had read as a pass. A warning about one
	 * line of a pull request's .gitattributes passed its key with no commit
	 * scanned, and so did a partial clone whose remote was out of reach.
	 */
	it("stop when the same git log writes anything to stderr, before gitleaks reads it", () => {
		const ask =
			'said="$(git -c gc.auto=0 log -p -U0 ${opts} 2>&1 > /dev/null)" ||\n';
		expect(scanBody).toContain(ask);
		expect(scanBody.indexOf(ask)).toBeLessThan(
			scanBody.indexOf("gitleaks git"),
		);
		expect(scanBody).toContain('said="${said:-git log failed}"\n');
		const said = scanBody.slice(scanBody.indexOf('if [ -n "$said" ]; then'));
		expect(said.slice(0, said.indexOf("\tfi"))).toContain("\t\treturn 1\n");
	});

	it("fail the check when either pass finds anything", () => {
		expect(code).toContain("set -euo pipefail\n");
		// A finding is printed and then fails: "return 0" there printed it and
		// passed.
		const returns = [...scanBody.matchAll(/\breturn\b.*$/gm)].map(([r]) => r);
		expect(returns).toEqual(["return 1", "return 1"]);
	});

	it("print a finding as its rule, file, line and commit, and nothing else of it", () => {
		expect(code).toContain("--report-format json");
		const printed = [...code.matchAll(/\$\{f\.(\w+)\}/g)].map(([, f]) => f);
		expect(printed.sort()).toEqual(["Commit", "File", "RuleID", "StartLine"]);
		expect(printer).toBe(PRINTER);
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
	 * gitleaks reads a .gitleaksignore at the root whatever -i is given, and,
	 * given no --config, a config from its environment or a .gitleaks.toml at
	 * the root. Any one of them would have let the pull request's own commits
	 * through too.
	 */
	it("refuse every other way gitleaks could be told to look away", () => {
		expect(code).toContain("unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML\n");
		expect(code).toContain("for ignored in .gitleaksignore .gitleaks.toml; do");
		const loop = code.slice(code.indexOf("for ignored in"));
		const body = loop.slice(0, loop.indexOf("done"));
		// The condition itself: "[ -e ... ] && false" refused nothing.
		expect(body).toContain('\tif [ -e "$ignored" ]; then\n');
		expect(body).toContain("exit 1");
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
