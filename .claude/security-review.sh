#!/usr/bin/env bash
# The security review in a session other than the one that made the change
# (AGENTS.md, "Security checks", step 3), run so that it cannot pass by
# saying nothing.
#
# The bare `claude -p "/security-review"` ran no turn on Claude Code 2.1.312
# and printed nothing with exit status 0. Asking for the skill in the prompt,
# with the diff named, runs it; and the transcript is read for whether it did
# (security-review-verdict.mjs), so a run that reviewed nothing exits 1.
#
#   .claude/security-review.sh            the branch against origin/main
#   .claude/security-review.sh <base>     against another base
#
# REPLY_RULES=off: nobody reads this as a reply to the owner (CLAUDE.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="${1:-origin/main}"

REPLY_RULES=off claude -p "Run the security-review skill: complete a security review of the pending changes on the current branch, that is \`git diff ${base}...HEAD\`. Report only findings at confidence 8 of 10 or above, each with its file, line, a concrete exploit scenario and a fix. If there are none, say so plainly." \
	--output-format stream-json --verbose \
	| node "$here/security-review-run.mjs"
