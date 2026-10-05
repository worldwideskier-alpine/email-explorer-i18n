#!/usr/bin/env bash
# Two of the checks every change passes before it is merged to main: no
# dependency with a known high or critical advisory, and no key in the
# commits being merged. The tests run in CI on the pull request, and
# /security-review runs in a session of its own; AGENTS.md has the order.
#
#   .claude/pre-merge-check.sh [base]     base defaults to origin/main
#
# Exits non-zero on the first check that fails. Gitleaks prints findings
# with their values redacted.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-origin/main}"

# Pinned, and fetched through the Go module proxy, whose checksum database
# vouches for the source: GitHub's release downloads are not reachable from
# every environment this runs in.
GITLEAKS_VERSION=v8.30.1

echo "== dependencies: pnpm audit, high and critical"
pnpm audit --audit-level high

echo "== keys in ${base}..HEAD: gitleaks ${GITLEAKS_VERSION}"
if ! command -v gitleaks > /dev/null; then
	GOBIN="${HOME}/.local/bin" go install \
		"github.com/zricethezav/gitleaks/v8@${GITLEAKS_VERSION}"
	export PATH="${HOME}/.local/bin:${PATH}"
fi
gitleaks git --log-opts="${base}..HEAD" --redact --no-banner .
