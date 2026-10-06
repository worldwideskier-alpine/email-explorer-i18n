// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings held here are shell and JavaScript, written as the script writes them
import { describe, expect, it } from "vitest";

/**
 * The properties of `.claude/pre-merge-check.sh` that keep a key out of main,
 * and of `.claude/gitleaks-known-history`, the one file that lets one through.
 *
 * The script is step 2 of "Security checks" in AGENTS.md. Each line of it
 * that decides whether a key gets through was measured, against clones made
 * for the purpose, letting one through when it was missing or written another
 * way -- and a change that undoes one reads like a change that tidies it.
 *
 * So the script is held here block by block, whole, comments and spacing
 * aside. An earlier version of this test looked for a phrase in each block,
 * and it went on passing while the block around the phrase was turned round:
 * a refusal that carried on instead of stopping, an ancestry check inverted,
 * a `case` that skipped every line, the scan pointed at a subdirectory. And
 * the script is held to be these blocks and nothing else, so a line put in
 * between two of them -- an early `exit 0` -- fails as well.
 *
 * The printer, the one part of the script in JavaScript, is also run here on
 * a report made for it. git and gitleaks are not: what they were measured
 * doing is in AGENTS.md and in the script's own comments.
 *
 * This cannot stop somebody who edits this file in the same pull request, and
 * is not meant to; workflowGuards.test.ts says why. Read with
 * import.meta.glob rather than node:fs for the reason formContrast.test.ts
 * documents: src/ is type-checked without Node types.
 */

const files = import.meta.glob<string>(
	[
		"../../../../.claude/pre-merge-check.sh",
		"../../../../.claude/gitleaks-known-history",
	],
	{ query: "?raw", import: "default", eager: true },
);

const fileEndingIn = (name: string) =>
	Object.entries(files).find(([path]) => path.endsWith(name))?.[1] ?? "";

const script = fileEndingIn("/pre-merge-check.sh");
const known = fileEndingIn("/gitleaks-known-history");

/**
 * The script as lines of code: comment lines and blank lines left out, and
 * every run of spaces and tabs read as one space. A comment or an indent can
 * change without a change here; nothing else can.
 */
const code = script
	.split("\n")
	.map((line) => line.replace(/[ \t]+/g, " ").trim())
	.filter((line) => line !== "" && !line.startsWith("#"));

/** The lines of code from `block`'s first line on, as many as it has. */
function found(block: readonly string[]): string[] {
	const start = code.indexOf(block[0]);
	return start < 0 ? [] : code.slice(start, start + block.length);
}

/**
 * `set -e` and `pipefail`: a check that failed and carried on would end in
 * the next one's success, and the script's status is what stops a merge.
 */
const SETUP = [
	"set -euo pipefail",
	'cd "$(git rev-parse --show-toplevel)"',
	'base="${1:-origin/main}"',
	"known=.claude/gitleaks-known-history",
];

/** The audit, then gitleaks at the version everything here was measured on. */
const AUDIT_AND_INSTALL = [
	"GITLEAKS_VERSION=v8.30.1",
	'echo "== dependencies: pnpm audit, high and critical"',
	"pnpm audit --audit-level high",
	"if ! command -v gitleaks > /dev/null; then",
	'GOBIN="${HOME}/.local/bin" go install \\',
	'"github.com/zricethezav/gitleaks/v8@${GITLEAKS_VERSION}"',
	'export PATH="${HOME}/.local/bin:${PATH}"',
	"fi",
];

/**
 * A shallow clone passed the full scan on history it never read; a base that
 * does not resolve made gitleaks scan no commits and succeed.
 */
const WHOLE_HISTORY = [
	'if [ "$(git rev-parse --is-shallow-repository)" = true ]; then',
	"git fetch --quiet --unshallow",
	"fi",
	'git rev-parse --verify --quiet "${base}^{commit}" > /dev/null || {',
	'echo "${base} is not a commit in this clone" >&2',
	"exit 1",
	"}",
];

/**
 * gitleaks reads `.gitleaksignore` at the root whatever `-i` names, and,
 * given no `--config`, a config from its environment or from
 * `.gitleaks.toml`. Each of them silenced the commits being merged as well.
 * Only the first has anywhere else to send what it held, and only a
 * fingerprint by commit; a config has nowhere, since the check runs
 * gitleaks' default one alone.
 */
const ROOT_FILES = [
	"unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML",
	"for ignored in .gitleaksignore .gitleaks.toml; do",
	'if [ -e "$ignored" ]; then',
	'echo "${ignored} at the root would silence every scan" >&2',
	'if [ "$ignored" = .gitleaksignore ]; then',
	'echo "a fingerprint of history on ${base}, by commit, goes in ${known}" >&2',
	"fi",
	"exit 1",
	"fi",
	"done",
];

/**
 * Only history already on the base may be registered, and only by commit: a
 * fingerprint of three fields lets that file and line through in every
 * commit, the ones being merged included. A line is named by its number and
 * never printed, since a line that is not a fingerprint could be a pasted
 * value.
 */
const KNOWN = [
	'[ -f "$known" ] || {',
	'echo "${known} is missing" >&2',
	"exit 1",
	"}",
	"fingerprint='^([0-9a-f]{40}):[^:]+:[a-z0-9-]+:[0-9]+$'",
	"number=0",
	'while IFS= read -r line || [ -n "$line" ]; do',
	"number=$((number + 1))",
	'case "$line" in "#"* | "") continue ;; esac',
	"[[ $line =~ ^[[:space:]]*$ ]] && continue",
	"if ! [[ $line =~ $fingerprint ]]; then",
	'echo "${known}:${number} is not <commit>:<path>:<rule>:<line>" >&2',
	"exit 1",
	"fi",
	'commit="${BASH_REMATCH[1]}"',
	'git cat-file -e "${commit}^{commit}" 2> /dev/null || continue',
	'if ! git merge-base --is-ancestor "$commit" "$base"; then',
	'echo "${known}:${number} names a commit that is not on ${base}" >&2',
	"exit 1",
	"fi",
	'done < "$known"',
];

/**
 * What both scans read, whatever the runner's own git config says. Each was
 * measured letting a key through both scans without it: `--no-color`
 * (`color.ui=always`), `--root` (`log.showRoot=false`, with a pull request
 * merging in a history whose root adds the key), `--diff-merges=separate`
 * (merges otherwise show no diff; `-m` follows `log.diffMerges`, which set
 * to `combined` read nothing of a merge), `--text` and `--no-textconv` (a
 * `.gitattributes` or a NUL byte made it "Binary files differ").
 */
const OPTIONS = [
	'report="$(mktemp -d)"',
	"trap 'rm -rf \"$report\"' EXIT",
	"scan() {",
	'local name="$1" said',
	'local opts="--no-color --root --diff-merges=separate --text --no-textconv $2"',
	"shift 2",
];

/**
 * gitleaks stops reading at the first line git writes to stderr and reports
 * what it had read as a pass, so the same git log runs first and anything it
 * says stops the check. What git says can quote the pull request's own bytes,
 * so it is shown through `cat -v`.
 */
const STDERR = [
	'said="$(git -c gc.auto=0 log -p -U0 ${opts} 2>&1 > /dev/null)" ||',
	'said="${said:-git log failed}"',
	'if [ -n "$said" ]; then',
	'echo "git log wrote to stderr, which ends a ${name} scan early:" >&2',
	"printf '%s\\n' \"$said\" | cat -v >&2",
	"return 1",
	"fi",
];

/**
 * gitleaks itself: no `--config`, no `-v` (it prints the author), no
 * `--exit-code` (its status is the check's), the whole clone as the source
 * (gitleaks reads `.gitleaksignore` from wherever the source is), and a
 * `gitleaks:allow` on a line not honoured.
 */
const GITLEAKS = [
	'if ! gitleaks git --log-opts="${opts}" --redact \\',
	"--no-banner --ignore-gitleaks-allow --report-format json \\",
	'--report-path "${report}/${name}.json" "$@" .; then',
	"node -e '",
];

/**
 * The printer: a finding's rule, file, line and commit and nothing else of
 * it, and the file -- which a pull request names -- as a JSON string in
 * printable ASCII.
 */
const PRINTER = [
	'const fs = require("node:fs");',
	"const path = process.argv[1];",
	"if (!fs.existsSync(path)) {",
	'console.error("gitleaks stopped before it wrote a report");',
	"process.exit();",
	"}",
	"const shown = (name) =>",
	"JSON.stringify(String(name)).replace(",
	"/[^\\x20-\\x7e]/g,",
	'(c) => `\\\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,',
	");",
	'for (const f of JSON.parse(fs.readFileSync(path, "utf8"))) {',
	"console.error(`${f.RuleID} ${shown(f.File)}:${f.StartLine} in ${f.Commit}`);",
	"}",
];

const PRINTED = [`' "\${report}/\${name}.json"`, "return 1", "fi", "}"];

/**
 * The commits being merged, read without the registered file; then all of
 * HEAD's history, read with it.
 */
const PASSES = [
	'echo "== keys in ${base}..HEAD: gitleaks ${GITLEAKS_VERSION}"',
	'scan range "${base}..HEAD"',
	'echo "== keys in all of HEAD\'s history, less ${known}"',
	'scan full HEAD -i "$known"',
];

/** The printer's program, exactly as `node -e` is given it. */
const printer =
	/node -e '\n([\s\S]*?)\n[ \t]*' "\$\{report\}\/\$\{name\}\.json"/.exec(
		script,
	)?.[1] ?? "";

type Finding = Record<string, unknown>;

/**
 * Runs the printer on `report`, or on no report at all, with a stand-in for
 * node:fs, and returns every line it wrote to either stream. Anything else it
 * reaches for -- another module, another function of fs -- throws, and fails
 * the test. The program is the script's own, which node runs on every check
 * anyway; a pull request that changed it would be changing this file too.
 */
function print(report?: Finding[]): string[] {
	const printed: string[] = [];
	const write = (...parts: unknown[]) => {
		printed.push(parts.map(String).join(" "));
	};
	const exited = new Error("process.exit");
	const fs = {
		existsSync: () => report !== undefined,
		readFileSync: () => JSON.stringify(report),
	};
	const program = new Function("require", "process", "console", printer);
	try {
		program(
			(name: string) => {
				if (name !== "node:fs") throw new Error(`required ${name}`);
				return fs;
			},
			{
				argv: ["node", "report.json"],
				exit: () => {
					throw exited;
				},
				stdout: { write },
				stderr: { write },
			},
			{ error: write, log: write, info: write, warn: write, debug: write },
		);
	} catch (error) {
		if (error !== exited) throw error;
	}
	return printed.flatMap((text) => text.split("\n"));
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A finding as gitleaks writes it to a JSON report, every field filled in. */
const finding = (file: string): Finding => ({
	RuleID: "curl-auth-header",
	Description: "never-printed-description",
	StartLine: 1438,
	EndLine: 1438,
	StartColumn: 1,
	EndColumn: 9,
	Match: "never-printed-match",
	Secret: "never-printed-secret",
	File: file,
	SymlinkFile: "never-printed-symlink",
	Commit: COMMIT,
	Entropy: 4.5,
	Author: "never-printed-author",
	Email: "never-printed-email",
	Date: "never-printed-date",
	Message: "never-printed-message",
	Tags: ["never-printed-tag"],
	Fingerprint: "never-printed-fingerprint",
	Link: "never-printed-link",
});

describe("the pre-merge check", () => {
	it("is where this test thinks it is", () => {
		// A rename would otherwise turn every assertion below into a silent pass.
		expect(script, "pre-merge-check.sh not found").toBeTruthy();
		expect(known, "gitleaks-known-history not found").toBeTruthy();
		expect(printer, "the printer's node -e not found").toBeTruthy();
	});

	it("stops at the first check that fails, and fails when either scan finds anything", () => {
		expect(found(SETUP)).toEqual(SETUP);
		expect(code[0]).toBe("set -euo pipefail");
		// Every way out of a refusal, and out of scan() once something is found
		// or git has spoken, is a failure.
		const exits = code.filter((line) => /^(exit|return)\b/.test(line));
		expect(exits.length).toBeGreaterThan(0);
		for (const line of exits) expect(line).toMatch(/^(exit|return) 1$/);
		expect(code.join("\n")).not.toMatch(/\|\|\s*true\b/);
	});

	it("audits the dependencies, and installs the pinned gitleaks when there is none", () => {
		expect(found(AUDIT_AND_INSTALL)).toEqual(AUDIT_AND_INSTALL);
	});

	it("reads the whole history, from a base that exists", () => {
		expect(found(WHOLE_HISTORY)).toEqual(WHOLE_HISTORY);
	});

	it("refuses every other way gitleaks could be told to look away", () => {
		expect(found(ROOT_FILES)).toEqual(ROOT_FILES);
	});

	it("accepts only a commit fingerprint, and only of a commit on the base", () => {
		expect(found(KNOWN)).toEqual(KNOWN);
	});

	it("reads every commit whole, whatever the runner's git config says", () => {
		expect(found(OPTIONS)).toEqual(OPTIONS);
	});

	it("stops when the same git log writes anything to stderr, before gitleaks reads it", () => {
		expect(found(STDERR)).toEqual(STDERR);
		expect(code.indexOf(STDERR[0])).toBeLessThan(code.indexOf(GITLEAKS[0]));
	});

	it("runs gitleaks once, in the function both scans share", () => {
		expect(found(GITLEAKS)).toEqual(GITLEAKS);
		expect(code.filter((line) => line.includes("gitleaks git"))).toEqual([
			GITLEAKS[0],
		]);
		const inScan = code.slice(code.indexOf("scan() {"));
		expect(inScan).toContain(GITLEAKS[0]);
		// Nothing anywhere names a config, a verbose report or an exit status of
		// its own; and the call itself takes no short form of either.
		expect(code.join("\n")).not.toMatch(/--exit-code|--verbose|--config/);
		expect(found(GITLEAKS).join(" ")).not.toMatch(/\s-[vc]\s/);
	});

	it("scans the commits being merged without the registered file, and all of HEAD's history with it", () => {
		expect(found(PASSES)).toEqual(PASSES);
		// Both go through scan(), which reads merges and root commits; neither
		// may hand git log anything but where to start.
		expect(code.filter((line) => line.startsWith("scan "))).toEqual([
			PASSES[1],
			PASSES[3],
		]);
	});

	it("is these blocks, in this order, and nothing else", () => {
		expect(code).toEqual([
			...SETUP,
			...AUDIT_AND_INSTALL,
			...WHOLE_HISTORY,
			...ROOT_FILES,
			...KNOWN,
			...OPTIONS,
			...STDERR,
			...GITLEAKS,
			...PRINTER,
			...PRINTED,
			...PASSES,
		]);
	});
});

describe("the printer of a finding", () => {
	it("prints a finding as its rule, file, line and commit, and nothing else of it", () => {
		expect(print([finding("ROADMAP.md"), finding("docs/a.md")])).toEqual([
			`curl-auth-header "ROADMAP.md":1438 in ${COMMIT}`,
			`curl-auth-header "docs/a.md":1438 in ${COMMIT}`,
		]);
	});

	it("prints a file's name in printable ASCII, so that a name cannot write a line of the check's own", () => {
		// Measured: printed as it came, this name put "== keys: no leaks found"
		// on a line of its own, and the escape that follows hides what comes
		// after it on many terminals.
		const name = "zzz.md\n== keys: no leaks found\u001b[8m\u009b‮к\u{1f511}";
		const lines = print([finding(name)]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^[\x20-\x7e]*$/);
		const quoted = /^curl-auth-header (".*"):1438 in [0-9a-f]{40}$/.exec(
			lines[0],
		)?.[1];
		expect(JSON.parse(quoted ?? "null")).toBe(name);
	});

	it("says so when gitleaks stopped before it wrote a report", () => {
		expect(print()).toEqual(["gitleaks stopped before it wrote a report"]);
	});

	it("is the program the script gives node, line for line", () => {
		expect(found(PRINTER)).toEqual(PRINTER);
	});
});

describe("the registered history", () => {
	const fingerprint = new RegExp(
		/^fingerprint='(.*)'$/.exec(
			code.find((line) => line.startsWith("fingerprint=")) ?? "",
		)?.[1] ?? "(?!)",
	);
	const lines = known.split("\n");
	const isFingerprint = (line: string) =>
		line !== "" && !line.startsWith("#") && line.trim() !== "";

	it("names each finding by its commit", () => {
		const registered = lines.filter(isFingerprint);
		expect(registered.length).toBeGreaterThan(0);
		for (const line of registered) expect(line).toMatch(fingerprint);
		// The shapes the script refuses, so the pattern read above is the one
		// that refuses them.
		expect("ROADMAP.md:curl-auth-header:1438").not.toMatch(fingerprint);
		expect("9cb6794:ROADMAP.md:curl-auth-header:1438").not.toMatch(fingerprint);
	});

	it("gives every group of fingerprints its reason right above it", () => {
		lines.forEach((line, i) => {
			if (!isFingerprint(line) || (i > 0 && isFingerprint(lines[i - 1]))) {
				return;
			}
			expect(lines[i - 1] ?? "", `line ${i + 1}`).toMatch(/^# \S/);
		});
	});
});
