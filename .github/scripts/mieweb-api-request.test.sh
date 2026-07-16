#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=mieweb-api-request.sh
source "${repo_root}/.github/scripts/mieweb-api-request.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
counter_file="${tmp_dir}/counter"
args_file="${tmp_dir}/args"
mode=""

# Test double for curl. request() still owns all retry, timeout, response-file,
# HTTP-status, and method-safety behavior under test.
curl() {
  local response_file="" arg count
  printf '%s\n' "$*" >> "$args_file"
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    if [ "$arg" = "-o" ]; then
      response_file="$1"
      shift
    fi
  done
  [ -n "$response_file" ] || fail "curl was not given a response file"

  count="$(cat "$counter_file" 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > "$counter_file"

  case "$mode" in
    transient-then-success)
      if [ "$count" -lt 3 ]; then
        echo "simulated connect timeout" >&2
        return 28
      fi
      printf '{"data":[]}' > "$response_file"
      printf '200'
      ;;
    unauthorized)
      printf '{"error":"unauthorized"}' > "$response_file"
      printf '401'
      ;;
    always-transient)
      echo "simulated connect timeout" >&2
      return 28
      ;;
    *)
      fail "unknown curl mode: $mode"
      ;;
  esac
}

# JSON validation is not the behavior under test; production and CI provide jq.
jq() { return 0; }

api_base="https://manager.example/api/v1"
MIEWEB_API_KEY="test-key"
MIEWEB_REQUEST_ATTEMPTS=3
MIEWEB_REQUEST_RETRY_DELAY_SECONDS=0
MIEWEB_REQUEST_CONNECT_TIMEOUT_SECONDS=10
MIEWEB_REQUEST_MAX_TIME_SECONDS=30

mode="transient-then-success"
echo 0 > "$counter_file"
: > "$args_file"
result="$(request GET /sites 2>"${tmp_dir}/retry.err")"
[ "$result" = '{"data":[]}' ] || fail "GET did not return the successful JSON response"
[ "$(cat "$counter_file")" = "3" ] || fail "transient GET was not attempted three times"
grep -q -- '--connect-timeout 10' "$args_file" || fail "curl connect timeout is missing"
grep -q -- '--max-time 30' "$args_file" || fail "curl overall timeout is missing"
grep -q 'transient failure.*attempt 1/3' "${tmp_dir}/retry.err" || fail "retry warning is missing"

mode="unauthorized"
echo 0 > "$counter_file"
if request GET /sites >"${tmp_dir}/unauthorized.out" 2>"${tmp_dir}/unauthorized.err"; then
  fail "HTTP 401 unexpectedly succeeded"
fi
[ "$(cat "$counter_file")" = "1" ] || fail "permanent HTTP 401 was retried"

mode="always-transient"
echo 0 > "$counter_file"
if request POST /sites >"${tmp_dir}/post.out" 2>"${tmp_dir}/post.err"; then
  fail "transient POST unexpectedly succeeded"
fi
[ "$(cat "$counter_file")" = "1" ] || fail "non-idempotent POST was retried"

echo "PASS: MIE manager request retries are bounded and method-safe"
