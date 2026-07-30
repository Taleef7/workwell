#!/usr/bin/env bash
# Syntax-check every `run:` block in every workflow — the guard that did not exist (review, #356).
#
# ## Why
#
# PR-9c added a comment inside a jq program that lives in a SINGLE-QUOTED shell string. The comment
# contained apostrophes (`CMS's`, `WorkWell's`), and the first one CLOSED the quote — turning the
# production deploy step into a bash syntax error. Nothing caught it:
#
#   - `deploy-twh-mieweb.yml` only runs on push to main, i.e. AFTER merge;
#   - the new `official-flip-config.test.ts` passed 3/3, because it validates the SEMANTICS of a line
#     the shell would never execute;
#   - extracting the jq program and running it standalone (which is what the author did) bypasses the
#     shell quoting entirely — the program was always fine; the string containing it was not.
#
# The failure mode is nasty rather than merely annoying: `build-backend-ts` succeeds and pushes a new
# `:latest`, the deploy step dies BEFORE the delete/recreate, so the live container survives on the old
# image — and then the 15-minute self-heal reconciler recreates it from the new `:latest`, delivering the
# change unattended through a path nobody reviewed as the delivery mechanism, while the deploy is red.
#
# ## What this checks, and what it does not
#
# `bash -n` parses without executing: it catches unbalanced quotes, unclosed heredocs, `if`/`fi` and
# `do`/`done` mismatches. It does NOT catch logic errors, undefined variables, or anything requiring
# execution — that is `shellcheck`'s job and a reasonable follow-up. This is the cheap check that
# happens to catch the exact class that reached production config.
#
# GitHub expression syntax (`${{ … }}`) is left alone: it is substituted before the shell sees it, and it
# is valid inside a double-quoted bash string, which is how these workflows use it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

failures=0
checked=0

# Resolve an interpreter rather than assuming `python3` — it is `python` on some Windows dev shells, and
# a missing interpreter must be a HARD FAILURE, never a quiet zero-block pass.
py=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import sys; sys.exit(0 if sys.version_info[0]==3 else 1)" >/dev/null 2>&1; then
    py="$candidate"
    break
  fi
done
if [ -z "$py" ]; then
  echo "::error::no python3 interpreter found — this guard cannot run, and a guard that cannot run must fail loudly rather than report success."
  exit 1
fi

# Extract each `run:` block. Collected into a file first, NOT piped into `while` via process
# substitution: a failing extractor there would leave the loop with nothing to read and the script would
# sail on to print a cheerful summary having checked nothing. That is the exact vacuous-guard shape this
# script was written to catch, and the first version of it had the bug (review, #356 — caught by running
# it on a machine without python3, which reported "All workflow run-blocks parse" after checking 0).
blocks_list="$(mktemp)"
if ! "$py" .github/scripts/extract-run-blocks.py > "$blocks_list"; then
  echo "::error::extracting run-blocks failed — cannot verify workflow shell syntax."
  exit 1
fi

while IFS= read -r block_file; do
  [ -s "$block_file" ] || continue
  checked=$((checked + 1))
  if ! err="$(bash -n "$block_file" 2>&1)"; then
    label="$(head -n 1 "${block_file}.label")"
    echo "::error::shell syntax error in ${label}"
    echo "$err" | sed 's/^/    /'
    failures=$((failures + 1))
  fi
done < "$blocks_list"

echo "Checked ${checked} bash run-block(s) across .github/workflows/."

# A floor, not a formality. Every workflow in this repo has run-blocks; a count that collapses means the
# extractor broke against a reformat, and reporting green on that is worse than reporting red.
MIN_BLOCKS=20
if [ "$checked" -lt "$MIN_BLOCKS" ]; then
  echo "::error::only ${checked} run-block(s) found (expected >= ${MIN_BLOCKS}). The extractor is broken, not the workflows."
  exit 1
fi
if [ "$failures" -gt 0 ]; then
  echo "::error::${failures} workflow run-block(s) do not parse. A broken deploy step cannot be caught after merge."
  exit 1
fi
echo "All ${checked} workflow run-blocks parse."
