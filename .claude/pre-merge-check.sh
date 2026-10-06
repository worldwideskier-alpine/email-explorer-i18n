#!/usr/bin/env bash
# Two of the checks every change passes before it is merged to main: no
# dependency with a known high or critical advisory, and no key that
# gitleaks' default rules find in what the commits being merged change, or
# in what the history they sit on changed. What that leaves unread -- a
# commit's message, and whatever the default config allows -- is listed in
# AGENTS.md ("Security checks") and is for review. The tests run in CI on the
# pull request, and /security-review runs in a session of its own; AGENTS.md
# has the order.
#
#   .claude/pre-merge-check.sh [base]     base defaults to origin/main
#
# Exits non-zero on the first check that fails. A key found is printed as its
# rule, file, line and commit: never its value, and never its author.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-origin/main}"
known=.claude/gitleaks-known-history

# Pinned, and fetched through the Go module proxy, whose checksum database
# vouches for the source: GitHub's release downloads are not reachable from
# every environment this runs in.
GITLEAKS_VERSION=v8.30.1

echo "== dependencies: pnpm audit, high and critical"
pnpm audit --audit-level high

if ! command -v gitleaks > /dev/null; then
	GOBIN="${HOME}/.local/bin" go install \
		"github.com/zricethezav/gitleaks/v8@${GITLEAKS_VERSION}"
	export PATH="${HOME}/.local/bin:${PATH}"
fi

# A shallow clone would pass the full scan on history it never read, and
# could not say whether a registered commit is on the base.
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
	git fetch --quiet --unshallow
fi
# Given a base that does not resolve, gitleaks scans no commits and succeeds.
git rev-parse --verify --quiet "${base}^{commit}" > /dev/null || {
	echo "${base} is not a commit in this clone" >&2
	exit 1
}

# gitleaks reads <source>/.gitleaksignore on every scan, whatever -i names;
# and, given no --config, it takes its config from GITLEAKS_CONFIG or
# GITLEAKS_CONFIG_TOML, else from <source>/.gitleaks.toml. Each of them
# silenced the commits being merged as well, so none is allowed. Of what
# they hold, only a fingerprint by commit of history on the base has
# somewhere else to go -- ${known}, which only the full scan reads. A config
# (rules, allowlists) and a fingerprint of three fields have nowhere: this
# check runs gitleaks' default config and nothing else.
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML
for ignored in .gitleaksignore .gitleaks.toml; do
	if [ -e "$ignored" ]; then
		echo "${ignored} at the root would silence every scan" >&2
		if [ "$ignored" = .gitleaksignore ]; then
			echo "a fingerprint of history on ${base}, by commit, goes in ${known}" >&2
		fi
		exit 1
	fi
done

# Only history already on the base may be registered, and only by commit: a
# fingerprint of three fields lets that file and line through in every
# commit, the ones being merged included. Lines are named by number, since a
# line that is not a fingerprint could be anything, a pasted value included.
[ -f "$known" ] || {
	echo "${known} is missing" >&2
	exit 1
}
fingerprint='^([0-9a-f]{40}):[^:]+:[a-z0-9-]+:[0-9]+$'
number=0
while IFS= read -r line || [ -n "$line" ]; do
	number=$((number + 1))
	case "$line" in "#"* | "") continue ;; esac
	[[ $line =~ ^[[:space:]]*$ ]] && continue
	if ! [[ $line =~ $fingerprint ]]; then
		echo "${known}:${number} is not <commit>:<path>:<rule>:<line>" >&2
		exit 1
	fi
	commit="${BASH_REMATCH[1]}"
	# A commit this clone does not have matches nothing it scans: a fork
	# that copied the files rather than the history has none of these.
	git cat-file -e "${commit}^{commit}" 2> /dev/null || continue
	if ! git merge-base --is-ancestor "$commit" "$base"; then
		echo "${known}:${number} names a commit that is not on ${base}" >&2
		exit 1
	fi
done < "$known"

report="$(mktemp -d)"
trap 'rm -rf "$report"' EXIT
# Both scans read git log -p with these, whatever the runner's own git config
# says; each setting named was measured hiding a key from both scans.
# --no-color: color.ui=always made a diff gitleaks could not parse.
# --root: log.showRoot=false printed a root commit as no diff, and a pull
# request can merge in a history of its own whose root adds a key that the
# next commit takes out.
# --diff-merges=separate: git log shows a merge no diff at all, so a key that
# only a merge put in -- a conflict's resolution, or a file the merge added
# itself -- was never read. Not -m, which takes its format from
# log.diffMerges and, set to combined, read nothing of a merge again; nor
# --cc, which gitleaks does not parse.
# --text and --no-textconv: git log -p prints a file it takes for binary as
# "Binary files differ", and gitleaks skips it. A .gitattributes (-diff,
# binary, a diff driver) or one NUL byte in the file hid its key.
# --ignore-gitleaks-allow: a "gitleaks:allow" on the line let it through.
# The report is read for its rule, file, line and commit alone; gitleaks' own
# -v prints the author's name and address beside them.
# What gitleaks' default config allows whatever it is given -- lock files,
# images, documents, vendored code, values with "false" in them, lines some
# rules accept -- neither scan reads; that is for review to catch (AGENTS.md,
# "Security checks", has the list).
#
# scan <name> <git log arguments> [further gitleaks arguments]
scan() {
	local name="$1" said
	local opts="--no-color --root --diff-merges=separate --text --no-textconv $2"
	shift 2
	# gitleaks stops reading git's output at the first line git writes to
	# stderr, and reports what it had read as a pass: one line of a pull
	# request's .gitattributes that git warns about, or a partial clone whose
	# remote was out of reach, passed a key with nothing scanned. So the same
	# git log runs first, its arguments split on spaces as gitleaks splits
	# them, and anything it says stops the check. gc.auto=0: in a partial
	# clone this run fetches the blobs, and each fetch said it was packing.
	said="$(git -c gc.auto=0 log -p -U0 ${opts} 2>&1 > /dev/null)" ||
		said="${said:-git log failed}"
	if [ -n "$said" ]; then
		echo "git log wrote to stderr, which ends a ${name} scan early:" >&2
		# cat -v: git quotes a pull request's own bytes back -- an attribute
		# name in its .gitattributes -- and an escape there, printed as it
		# came, could hide this line or write one of the check's own.
		printf '%s\n' "$said" | cat -v >&2
		return 1
	fi
	if ! gitleaks git --log-opts="${opts}" --redact \
		--no-banner --ignore-gitleaks-allow --report-format json \
		--report-path "${report}/${name}.json" "$@" .; then
		# A file's name is the pull request's choice, so it is printed as a
		# JSON string in printable ASCII: as it came, a newline and an escape
		# in a name printed "no leaks found" as a line of the check's own.
		node -e '
			const fs = require("node:fs");
			const path = process.argv[1];
			if (!fs.existsSync(path)) {
				console.error("gitleaks stopped before it wrote a report");
				process.exit();
			}
			const shown = (name) =>
				JSON.stringify(String(name)).replace(
					/[^\x20-\x7e]/g,
					(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
				);
			for (const f of JSON.parse(fs.readFileSync(path, "utf8"))) {
				console.error(`${f.RuleID} ${shown(f.File)}:${f.StartLine} in ${f.Commit}`);
			}
		' "${report}/${name}.json"
		return 1
	fi
}

# The commits being merged are read whole -- merges and root commits
# included -- and without the registered file, so nothing in them can be
# registered away. That is more than the file's purpose: gitleaks matches a
# registered line against a finding's commit, file, rule and line, and also
# against a file *named* "<commit>:<path>" (git allows a colon in a path).
# While this scan skipped merges, a merge that added a file by that name was
# read only by the full scan, which let it through.
echo "== keys in ${base}..HEAD: gitleaks ${GITLEAKS_VERSION}"
scan range "${base}..HEAD"

# With merges read, a registered key a merge carries comes up again under the
# merge's own commit, and needs a line of its own -- a check that stops,
# rather than one that misses.
echo "== keys in all of HEAD's history, less ${known}"
scan full HEAD -i "$known"
