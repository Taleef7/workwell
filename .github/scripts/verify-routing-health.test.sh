#!/usr/bin/env bash
# The promotion gate (#768): every path that decides whether a deployed image may become the recovery tag.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=verify-routing-health.sh
source "${repo_root}/.github/scripts/verify-routing-health.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

ROUTING_HEALTH_ATTEMPTS=4
ROUTING_HEALTH_DELAY_SECONDS=0
SHA="6246aeca08b512f2ad1626045a7b82651823fd9b"
calls="${tmp_dir}/calls"

# What /health answers, per call: the old build until `new_from`, then `health_body` (a curl failure when
# "DOWN"). Not `body`: bash scopes dynamically, so this fake would read the gate function's own local.
old='{"status":"UP","build":{"sha":"0adba077"},"routing":{"official":["cms122"],"derived":[],"problems":0}}'
health_body=""
new_from=1

curl() {
  local n
  n=$(grep -c '^health' "$calls" 2>/dev/null || true)
  n=$((n + 1))
  echo "health ${n}" >> "$calls"
  if [ "$n" -lt "$new_from" ]; then printf '%s' "$old"; return 0; fi
  [ "$health_body" = "DOWN" ] && return 7
  printf '%s' "$health_body"
}

served() { # official-json derived-json problems
  printf '{"status":"UP","build":{"sha":"%s"},"routing":{"official":%s,"derived":%s,"problems":%s}}' "$SHA" "$1" "$2" "$3"
}

run() { # expected-official expected-derived
  : > "$calls"
  set +e
  verify_routing_health https://x/health "$SHA" "$1" "$2" > "${tmp_dir}/out" 2>&1
  local code=$?
  set -e
  echo "$code"
}

# 1. The new build answers with exactly its build-arg routing: promote.
health_body="$(served '["cms122","cms125","cms137"]' '["cms137"]' 0)"; new_from=1
[ "$(run "cms137, cms122,cms125" "cms137")" = 0 ] || fail "matching routing (any order, spaces) should pass: $(cat "${tmp_dir}/out")"

# 2. The old container answers first: wait for the new sha, then decide on ITS routing.
new_from=3
[ "$(run "cms122,cms125,cms137" "cms137")" = 0 ] || fail "should wait past the old build: $(cat "${tmp_dir}/out")"
[ "$(grep -c '^health' "$calls")" = 3 ] || fail "should stop polling once the new build answers"

# 3. The new build never answers: refuse after the attempts.
new_from=99
[ "$(run "cms122,cms125,cms137" "cms137")" = 1 ] || fail "a build that never answers must not be promoted"
grep -q "never answered as build" "${tmp_dir}/out" || fail "should say the build never answered"

# 4. The router refuses its routing: refuse at once, without waiting out the attempts.
health_body="$(served '["cms122"]' '[]' 2)"; new_from=1
[ "$(run "cms122" "")" = 1 ] || fail "routing problems must refuse the promotion"
[ "$(grep -c '^health' "$calls")" = 1 ] || fail "a final answer should not be polled again"
grep -q "2 routing problem" "${tmp_dir}/out" || fail "should report the problem count"

# 5. The image routes something other than its build args (a list dropped, or one too many).
health_body="$(served '["cms122","cms125"]' '[]' 0)"
[ "$(run "cms122,cms125,cms137" "")" = 1 ] || fail "a missing official id must refuse"
health_body="$(served '["cms122","cms125","cms137"]' '["cms137"]' 0)"
[ "$(run "cms122,cms125,cms137" "")" = 1 ] || fail "an unexpected translation must refuse"

# 6. A build that predates the routing field cannot say what it serves: refuse.
health_body="$(printf '{"status":"UP","build":{"sha":"%s"}}' "$SHA")"
[ "$(run "cms122" "")" = 1 ] || fail "no routing field must refuse"

# 7. A stack that routes nothing (staging-shaped): both lists empty pass.
health_body="$(served '[]' '[]' 0)"
[ "$(run "" "")" = 0 ] || fail "an empty routing that matches should pass: $(cat "${tmp_dir}/out")"

# 8. A transport failure is retried, not a verdict.
health_body="DOWN"
[ "$(run "" "")" = 1 ] || fail "a backend that never answers must not be promoted"
[ "$(grep -c '^health' "$calls")" = 4 ] || fail "a failed request should be retried up to the attempts"

echo "verify-routing-health: all cases pass"
