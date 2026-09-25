#!/usr/bin/env bash
# The restart-first self-heal (#663): every path that decides between "restarted, done" and "recreate".
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=mieweb-restart-first.sh
source "${repo_root}/.github/scripts/mieweb-restart-first.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

SITE_ID=1
MIEWEB_RESTART_HEALTH_ATTEMPTS=3
MIEWEB_RESTART_HEALTH_DELAY_SECONDS=0

registry="c-42"        # what the manager reports for the hostname: an id, EMPTY, or UNREADABLE
put_result=0           # the restart request's exit
healthy_from=1         # the health check answering UP from this check onwards (99 = never)
calls="${tmp_dir}/calls"

container_id_for_hostname() {
  echo "lookup $1" >> "$calls"
  case "$registry" in
    UNREADABLE) return 1 ;;
    EMPTY) printf '' ;;
    *) printf '%s' "$registry" ;;
  esac
}

request() {
  local method="$1" path="$2" body_file="${3:-}"
  echo "${method} ${path} $(cat "$body_file" 2>/dev/null)" >> "$calls"
  return "$put_result"
}

curl() {
  local n
  n=$(grep -c '^health' "$calls" 2>/dev/null || true)
  n=$((n + 1))
  echo "health ${n}" >> "$calls"
  if [ "$n" -ge "$healthy_from" ]; then printf '{"status":"UP"}'; else return 7; fi
}

reset() {
  : > "$calls"
  registry="c-42"
  put_result=0
  healthy_from=1
}

run() {
  set +e
  restart_in_place maui-api-ts https://x/actuator/health '"status":"UP"' > "${tmp_dir}/out" 2>&1
  local code=$?
  set -e
  echo "$code"
}

# 1. Healthy after the restart: done, and the request was restart-ONLY, aimed at the registered id.
reset
[ "$(run)" = 0 ] || fail "a restart that comes back healthy must succeed"
grep -qx 'PUT /sites/1/containers/c-42 {"restart":true}' "$calls" || fail "expected a restart-only PUT to c-42, got: $(cat "$calls")"

# 2. The body must carry nothing but restart: any other field makes it a config update that clears env.
reset
run > /dev/null
put_line="$(grep '^PUT ' "$calls")"
case "$put_line" in
  *environmentVars*|*entrypoint*|*services*) fail "the restart body must not carry config fields: $put_line" ;;
esac

# 3. Comes up on the third check: still a success, after polling.
reset
healthy_from=3
[ "$(run)" = 0 ] || fail "a restart that becomes healthy within the wait must succeed"
[ "$(grep -c '^health' "$calls")" = 3 ] || fail "expected 3 health checks"

# 4. Never healthy: fall back to recreate, after exactly the configured checks.
reset
healthy_from=99
[ "$(run)" = 1 ] || fail "still down after the restart must fall back to recreate"
[ "$(grep -c '^health' "$calls")" = 3 ] || fail "expected the configured 3 health checks"

# 5. The restart request's response is lost but the manager applied it: the health wait still runs and
#    decides, so a restart that happened is not followed by a recreate that deletes the stall report.
reset
put_result=1
[ "$(run)" = 0 ] || fail "an unconfirmed restart that the API comes back from must count as a restart"
grep -q '^health' "$calls" || fail "a failed restart request must still wait on health"

# 5b. The restart request failed and the API stays down: recreate, after the same wait.
reset
put_result=1
healthy_from=99
[ "$(run)" = 1 ] || fail "an unconfirmed restart with the API still down must fall back to recreate"
[ "$(grep -c '^health' "$calls")" = 3 ] || fail "expected the configured 3 health checks"

# 6. Cannot tell which container it is: no PUT at all.
reset
registry="UNREADABLE"
[ "$(run)" = 1 ] || fail "an unreadable registry must fall back to recreate"
grep -q '^PUT ' "$calls" && fail "nothing may be restarted when the id is unknown"

# 7. Nothing registered under the hostname: nothing to restart.
reset
registry="EMPTY"
[ "$(run)" = 1 ] || fail "an absent container must fall back to recreate"
grep -q '^PUT ' "$calls" && fail "nothing may be restarted when no container is registered"

echo "PASS: mieweb-restart-first (8 cases)"
