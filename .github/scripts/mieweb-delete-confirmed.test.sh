#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=mieweb-api-request.sh
source "${repo_root}/.github/scripts/mieweb-api-request.sh"
# shellcheck source=mieweb-delete-confirmed.sh
source "${repo_root}/.github/scripts/mieweb-delete-confirmed.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

SITE_ID=1
MIEWEB_DELETE_ATTEMPTS=3
MIEWEB_DELETE_CONFIRM_ATTEMPTS=2
MIEWEB_DELETE_CONFIRM_DELAY_SECONDS=0

# The helper pipes the list response through `jq -r '.data[0].id // empty'`. Neither jq nor the JSON
# shape is the behavior under test, so the fake GET returns a one-token stand-in for the list body
# and this jq extracts the id from it. The stand-in for an EMPTY list is deliberately non-empty,
# because the real `{"data":[]}` is too — conflating the two would hide the difference between a
# manager that answered "nothing here" and one that did not answer at all.
jq() {
  local body
  body="$(cat)"
  [ "$body" = "EMPTY" ] || printf '%s' "$body"
}

mode=""
delete_count_file="${tmp_dir}/delete_count"
get_count_file="${tmp_dir}/get_count"
registry_file="${tmp_dir}/registry" # the id the manager currently reports; empty = absent

bump() {
  local file="$1" count
  count="$(cat "$file" 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > "$file"
  echo "$count"
}

reset() {
  mode="$1"
  echo 0 > "$delete_count_file"
  echo 0 > "$get_count_file"
  echo "2026" > "$registry_file"
}

# Test double for the request boundary. delete_container_confirmed() still owns every decision
# under test: when to read back, when to re-issue, and when to give up.
request() {
  local method="$1" count
  case "$method" in
    DELETE)
      count="$(bump "$delete_count_file")"
      case "$mode" in
        clean)
          echo EMPTY > "$registry_file"
          return 0
          ;;
        timeout-but-applied)
          # The real 2026-08-30 / 2026-09-01 outage: curl gives up, the manager applied it anyway.
          echo EMPTY > "$registry_file"
          return 1
          ;;
        timeout-then-clean)
          if [ "$count" -eq 1 ]; then return 1; fi
          echo EMPTY > "$registry_file"
          return 0
          ;;
        always-timeout-persisting | manager-unreadable | unreadable-then-present | present-then-unreadable)
          return 1
          ;;
      esac
      ;;
    GET)
      count="$(bump "$get_count_file")"
      if [ "$mode" = "manager-unreadable" ]; then
        return 1
      fi
      # Flaky manager: the first read fails, later reads succeed and show the container present.
      if [ "$mode" = "unreadable-then-present" ] && [ "$count" -eq 1 ]; then
        return 1
      fi
      # The manager answers once, then goes away mid-window.
      if [ "$mode" = "present-then-unreadable" ] && [ "$count" -gt 1 ]; then
        return 1
      fi
      cat "$registry_file"
      return 0
      ;;
  esac
  fail "unexpected request: $*"
}

# 1. A clean DELETE is unchanged: one call, no read-back.
reset clean
delete_container_confirmed twh-api-ts 2026 2>/dev/null || fail "a clean DELETE did not succeed"
[ "$(cat "$delete_count_file")" = "1" ] || fail "a clean DELETE was issued more than once"
[ "$(cat "$get_count_file")" = "0" ] || fail "a clean DELETE read the container list unnecessarily"

# 2. THE OUTAGE. The DELETE fails and the manager applied it anyway: this must succeed, and it must
#    do so WITHOUT re-issuing the DELETE — the read-back is what resolves it.
reset timeout-but-applied
delete_container_confirmed twh-api-ts 2026 2>/dev/null || fail "a timed-out but applied DELETE was not confirmed by read-back"
[ "$(cat "$delete_count_file")" = "1" ] || fail "an already-applied DELETE was re-issued instead of confirmed"
[ "$(cat "$get_count_file")" -ge 1 ] || fail "the container list was never read back"

# 3. The DELETE fails and the container is demonstrably still there: re-issue, then succeed.
reset timeout-then-clean
delete_container_confirmed twh-api-ts 2026 2>/dev/null || fail "a re-issued DELETE did not succeed"
[ "$(cat "$delete_count_file")" = "2" ] || fail "a still-present container was not re-deleted exactly once"

# 4. Bounded: a container that never goes away fails rather than looping.
reset always-timeout-persisting
if delete_container_confirmed twh-api-ts 2026 2>/dev/null; then
  fail "an undeletable container was reported deleted"
fi
[ "$(cat "$delete_count_file")" = "3" ] || fail "the re-issue loop is not bounded by MIEWEB_DELETE_ATTEMPTS"

# 5. An unreachable manager must NOT read as a successful delete. Collapsing "could not tell" into
#    "absent" would let the deploy proceed to create over a container that is still running.
reset manager-unreadable
if delete_container_confirmed twh-api-ts 2026 2>/dev/null; then
  fail "an unreadable container list was treated as proof of deletion"
fi

# 6. ...and it must not read as "still present" either. Collapsing "could not tell" into "present"
#    makes the caller re-issue a DELETE into a state it cannot see -- the exact ambiguity this helper
#    exists to respect, and it could target an id the manager has since reused. Exactly ONE DELETE.
[ "$(cat "$delete_count_file")" = "1" ] || fail "an unreadable manager triggered a blind DELETE retry"

# 7. A read failure INSIDE the confirmation window is not decisive: the poll retries, sees the
#    container present, and the re-issue proceeds. Without this, one flaky read would abort a deploy
#    that the very next read would have resolved.
reset unreadable-then-present
if delete_container_confirmed twh-api-ts 2026 2>/dev/null; then
  fail "a persistently registered container was reported deleted"
fi
[ "$(cat "$delete_count_file")" = "3" ] || fail "a transient read failure stopped the re-issue loop"

# 8. A manager that answers "present" and then goes away mid-window is still UNKNOWN at the end of
#    it. Only the LAST observation may decide: letting a stale "present" survive a later read failure
#    reintroduces the blind retry, just from a different direction. (Found by mutation-checking test 6
#    -- clearing the stale value was in the code but nothing watched it fail.)
reset present-then-unreadable
if delete_container_confirmed twh-api-ts 2026 2>/dev/null; then
  fail "a manager that went unreachable mid-window was treated as proof of deletion"
fi
[ "$(cat "$delete_count_file")" = "1" ] || fail "a stale 'present' observation survived a later read failure and triggered a blind retry"

echo "PASS: an ambiguous container DELETE is resolved by reading the manager back; a manager that cannot be read is never guessed at"
