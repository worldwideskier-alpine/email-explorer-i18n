#!/usr/bin/env bash
# Two of the checks every change passes before it is merged to main: no
# dependency with a known high or critical advisory, and no key in the
# commits being merged or anywhere in the history they sit on. The tests run
# in CI on the pull request, and /security-review runs in a session of its
# own; AGENTS.md has the order.
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
# silenced the commits being merged as well, so none is allowed: what main's
# history needs goes in ${known}, which only the full scan reads.
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML
for ignored in .gitleaksignore .gitleaks.toml; do
	if [ -e "$ignored" ]; then
		echo "${ignored} at the root would silence every scan; use ${known}" >&2
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
# --no-color: color.ui=always in the runner's own git config made a diff
# gitleaks could not parse, and both scans passed a key. --text and
# --no-textconv: git log -p prints a file it takes for binary as "Binary
# files differ", and gitleaks skips it. A .gitattributes (-diff, binary, a
# diff driver) or one NUL byte in the file hid its key from both scans.
# --ignore-gitleaks-allow: a "gitleaks:allow" on the line let it through.
# The report is read for its rule, file, line and commit alone; gitleaks' own
# -v prints the author's name and address beside them.
# What gitleaks' default config allows whatever it is given -- lock files,
# images, node_modules, lines some rules accept -- neither scan reads; that
# is for review to catch (AGENTS.md, "Security checks").
scan() { # name, git log arguments, further gitleaks arguments
	local name="$1" opts="--no-color --text --no-textconv $2" said
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
		printf '%s\n' "$said" >&2
		return 1
	fi
	if ! gitleaks git --log-opts="${opts}" --redact \
		--no-banner --ignore-gitleaks-allow --report-format json \
		--report-path "${report}/${name}.json" "$@" .; then
		node -e '
			const fs = require("node:fs");
			const path = process.argv[1];
			if (!fs.existsSync(path)) {
				console.error("gitleaks stopped before it wrote a report");
				process.exit();
			}
			for (const f of JSON.parse(fs.readFileSync(path, "utf8"))) {
				console.error(`${f.RuleID} ${f.File}:${f.StartLine} in ${f.Commit}`);
			}
		' "${report}/${name}.json"
		return 1
	fi
}

echo "== keys in ${base}..HEAD: gitleaks ${GITLEAKS_VERSION}"
scan range "${base}..HEAD"

# --diff-merges=separate: without it git log shows a merge commit no diff at
# all, so a key that only the resolution of a conflict put in was never read
# (measured, as was --cc, which gitleaks does not parse). Not -m, which takes
# its format from log.diffMerges: set to combined in the runner's config, a
# merge was read as nothing again. With it, a registered key a merge carries
# comes up again under the merge's own commit, and needs a line of its own --
# a check that stops, rather than one that misses.
echo "== keys in all of HEAD's history, less ${known}"
scan full "--diff-merges=separate HEAD" -i "$known"
