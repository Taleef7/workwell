#!/usr/bin/env bash
# A push deploy waits for CI on its own commit and stops unless it passed (D4).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=wait-for-ci.sh
source "${repo_root}/.github/scripts/wait-for-ci.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

export GITHUB_REPOSITORY=owner/repo GITHUB_REF_NAME=main POLL_SECONDS=0 APPEAR_TIMEOUT_SECONDS=0
sleep() { :; }
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
answers=()   # what successive `gh run list` calls return
# The lookup runs in a command substitution (a subshell), so the call count lives in a file.
reset() { answers=("$@"); echo 0 > "${tmp_dir}/calls"; }
calls() { cat "${tmp_dir}/calls"; }
gh() {
  [ "$1 $2" = "run list" ] || fail "unexpected gh $*"
  [[ " $* " == *" --commit abc123 "* && " $* " == *" --event push "* && " $* " == *" --branch main "* ]] || fail "asked about the wrong run: $*"
  local n; n="$(calls)"
  printf '%s' "${answers[$n]:-}"
  echo $((n + 1)) > "${tmp_dir}/calls"
}

reset "7 in_progress " "7 completed success"
wait_for_ci abc123 >/dev/null || fail "a passing CI run stopped the deploy"
[ "$(calls)" -eq 2 ] || fail "did not wait for the run to finish"

for conclusion in failure cancelled timed_out; do
  reset "7 completed ${conclusion}"
  if wait_for_ci abc123 >/dev/null 2>&1; then fail "a '${conclusion}' CI run let the deploy continue"; fi
done

reset
if wait_for_ci abc123 >/dev/null 2>&1; then fail "a commit with no CI run was deployed"; fi

# Both push deploys wait before building, and only on a push.
for workflow in deploy-maui-mieweb deploy-twh-mieweb; do
  yaml="${repo_root}/.github/workflows/${workflow}.yml"
  grep -q 'wait-for-ci.sh' "$yaml" || fail "${workflow} does not wait for CI"
  for job in build-backend-ts build-frontend; do
    block="$(sed -n "/^  ${job}:/,/^  [a-z-]*:$/p" "$yaml")"
    grep -q 'needs: ci-passed' <<< "$block" || fail "${workflow}: ${job} does not wait for CI"
  done
done

echo "wait-for-ci: ok"
