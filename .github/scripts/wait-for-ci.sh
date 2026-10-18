#!/usr/bin/env bash
# A push deploy ships only a commit whose CI passed (D4).
#
#   bash .github/scripts/wait-for-ci.sh <sha>        # GH_TOKEN and GITHUB_REPOSITORY from the workflow
#
# A merge to main starts CI and both deploys at the same moment, so until now a commit whose tests failed was
# already deploying. This finds the CI workflow's push run for <sha>, waits for it, and exits 0 only when it
# succeeded: a failed, cancelled or missing run stops the deploy before anything is built. Branch protection
# already requires every check on the PR; this closes the gap between the PR's head and the squashed commit.
# A manual dispatch does not call this: it is the documented override for an urgent fix.
set -euo pipefail

CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"
APPEAR_TIMEOUT_SECONDS="${APPEAR_TIMEOUT_SECONDS:-600}"
POLL_SECONDS="${POLL_SECONDS:-30}"

# The CI push run for a commit ON THIS BRANCH (the same SHA can have a cancelled run on another branch), as
# "<id> <status> <conclusion>", or nothing when there is none yet.
ci_run_for() {
  gh run list --repo "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}" --workflow "$CI_WORKFLOW" \
    --commit "$1" --event push --branch "${GITHUB_REF_NAME:?GITHUB_REF_NAME is not set}" --limit 1 \
    --json databaseId,status,conclusion \
    --jq '.[0] // empty | "\(.databaseId) \(.status) \(.conclusion)"'
}

wait_for_ci() {
  local sha="$1" waited=0 run id status conclusion
  while :; do
    run="$(ci_run_for "$sha" || true)"
    if [ -n "$run" ]; then
      read -r id status conclusion <<< "$run"
      if [ "$status" = "completed" ]; then
        if [ "$conclusion" = "success" ]; then
          echo "CI run ${id} for ${sha} passed"
          return 0
        fi
        echo "::error::CI run ${id} for ${sha} ended '${conclusion}'; this commit is not deployed" >&2
        return 1
      fi
    elif [ "$waited" -ge "$APPEAR_TIMEOUT_SECONDS" ]; then
      echo "::error::no CI run for ${sha} appeared within ${APPEAR_TIMEOUT_SECONDS}s; this commit is not deployed" >&2
      return 1
    fi
    sleep "$POLL_SECONDS"
    waited=$((waited + POLL_SECONDS))
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  wait_for_ci "${1:?usage: wait-for-ci.sh <sha>}"
fi
