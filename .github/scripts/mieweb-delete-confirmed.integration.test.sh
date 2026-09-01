#!/usr/bin/env bash
set -euo pipefail

# WHY THIS FILE EXISTS, AND WHY IT STUBS `curl` RATHER THAN `request`.
#
# mieweb-delete-confirmed.test.sh substitutes a fake `request()`. That is the right boundary for
# testing the DECISIONS -- when to read back, when to re-issue, when to refuse -- and it does that
# well. But it cannot see anything about how the real request() behaves, and on 2026-09-01 the very
# first production run of the confirmed-delete path failed at exactly that seam:
#
#   Deleting existing container 'twh-api-ts' (ID 2033) before recreate...
#   curl: (28) Operation timed out after 30002 milliseconds with 0 bytes received
#   ::error::DELETE /sites/1/containers/2033 failed before HTTP response (curl exit 28)...
#   Process completed with exit code 1
#
# No read-back. No warning. The guard never ran. The cause was one line inside request(): an
# unconditional `set -e` that re-armed errexit BEFORE the function returned, reaching across the
# function boundary to undo the caller's `set +e`, so the shell exited on request()'s own non-zero
# return. The unit test could not possibly catch it, because its fake request() had no `set -e` in it
# -- the double diverged from the real thing in precisely the dimension that mattered.
#
# So this file drives the REAL request() and the REAL delete_container_confirmed(), under the same
# `set -euo pipefail` as deploy-mieweb-container.sh, and fakes only the process at the very bottom.
# The rule it encodes: when a guard's job is to survive a failure, test it against the real thing
# that fails.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repo_root}/.github/scripts"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# Runs one scenario in a fresh shell configured exactly as the deploy script is. Echoes the child's
# combined output; the caller asserts on it and on the exit status.
run_scenario() {
  local scenario="$1" outfile="${tmp_dir}/${1}.out"
  cat > "${tmp_dir}/runner.sh" <<RUNNER
set -euo pipefail   # <-- the whole point: identical to deploy-mieweb-container.sh line 2
source "${scripts}/mieweb-api-request.sh"
source "${scripts}/mieweb-delete-confirmed.sh"

api_base="https://manager.example/api/v1"
MIEWEB_API_KEY="test-key"
SITE_ID=1
MIEWEB_DELETE_CONFIRM_ATTEMPTS=2
MIEWEB_DELETE_CONFIRM_DELAY_SECONDS=0
MIEWEB_REQUEST_RETRY_DELAY_SECONDS=0
SCENARIO="${scenario}"
DELETE_COUNT_FILE="${tmp_dir}/${scenario}.deletes"
: > "\$DELETE_COUNT_FILE"

# The only fake in the chain. Models curl's real contract: write the body to the -o file, print the
# HTTP code on stdout, exit non-zero for a transport failure.
curl() {
  local response_file="" method=""
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      -o) response_file="\$2"; shift 2 ;;
      -X) method="\$2"; shift 2 ;;
      *)  shift ;;
    esac
  done
  case "\$method" in
    DELETE)
      echo D >> "\$DELETE_COUNT_FILE"
      echo "curl: (28) Operation timed out after 30002 milliseconds with 0 bytes received" >&2
      return 28
      ;;
    GET)
      case "\$SCENARIO" in
        applied)      printf '{"data":[]}' > "\$response_file"; printf '200' ;;
        still-there)  printf '{"data":[{"id":2033}]}' > "\$response_file"; printf '200' ;;
        unreadable)   echo "curl: (28) Operation timed out" >&2; return 28 ;;
      esac
      ;;
  esac
}

# CALLED BARE, exactly as deploy-mieweb-container.sh calls it. Wrapping this in && / || would put
# it in a condition context, where the shell suppresses errexit for the call AND everything beneath
# it -- which is how the first draft of this very file managed to pass with the production bug fully
# restored. The harness must not be gentler than the caller it stands in for.
delete_container_confirmed twh-api-ts 2033
echo "REACHED_END"
RUNNER
  set +e
  bash "${tmp_dir}/runner.sh" > "$outfile" 2>&1
  echo $? > "${tmp_dir}/${scenario}.exit"
  set -e
  cat "$outfile"
}

deletes_issued() { grep -c . "${tmp_dir}/$1.deletes" 2>/dev/null || echo 0; }

# 1. THE REGRESSION. A DELETE that fails at the transport, and a manager that reports the container
#    gone. Before the fix this aborted the shell at the DELETE -- no read-back, no warning, exit 1 --
#    and in production, a deleted backend and a deploy that stopped before recreating it.
out="$(run_scenario applied)"
[ "$(cat "${tmp_dir}/applied.exit")" = "0" ] || fail "a transport-failed DELETE that the manager had APPLIED did not succeed; the shell exited at the DELETE instead of reading the manager back (this is the 2026-09-01 production failure). Output: ${out}"
grep -q "REACHED_END" <<< "$out" || fail "the caller never regained control after the failed DELETE"
grep -q "the manager applied the delete despite the failed response" <<< "$out" || fail "the read-back did not run"
[ "$(deletes_issued applied)" -eq 1 ] || fail "an already-applied DELETE was re-issued"

# 2. The manager says the container is still registered: read back, re-issue, and fail the job
#    honestly when it never goes away. A non-zero exit is CORRECT here -- what must not happen is
#    exiting before the read-back, which the delete count and the message distinguish.
run_scenario still-there > /dev/null
out="$(cat "${tmp_dir}/still-there.out")"
[ "$(cat "${tmp_dir}/still-there.exit")" != "0" ] || fail "a container that never went away was reported deleted"
grep -q "is still registered as ID 2033" <<< "$out" || fail "the shell exited at the DELETE instead of reading the manager back"
[ "$(deletes_issued still-there)" -eq 3 ] || fail "the re-issue loop did not run, or is not bounded by MIEWEB_DELETE_ATTEMPTS"

# 3. The manager cannot be read at all: refuse, saying why, with NO blind retry.
run_scenario unreadable > /dev/null
out="$(cat "${tmp_dir}/unreadable.out")"
[ "$(cat "${tmp_dir}/unreadable.exit")" != "0" ] || fail "an unreadable manager was treated as proof of deletion"
grep -q "could not be read back" <<< "$out" || fail "the refusal did not name the reason; the shell may have exited at the DELETE instead"
[ "$(deletes_issued unreadable)" -eq 1 ] || fail "an unreadable manager triggered a blind DELETE retry"

echo "PASS: the confirmed delete survives a real transport failure through the real request boundary"
