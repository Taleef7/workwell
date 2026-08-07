#!/usr/bin/env bash
# Tests for the E2E target allowlist (review, #407).
#
#   bash .github/scripts/e2e-target-allowed.test.sh
#
# The point of the guard is that it REFUSES production. A test suite for it that only checked the
# allowed cases would pass just as happily against a script with no refusal branch at all — so the
# refusals are the assertions that matter, and production is named explicitly among them.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/e2e-target-allowed.sh"
failures=0

allow() {
  if bash "${script}" "$1" >/dev/null 2>&1; then
    echo "  ok      allowed: $1"
  else
    echo "  FAIL    should be allowed but was refused: $1" >&2
    failures=$((failures + 1))
  fi
}

refuse() {
  if bash "${script}" "$1" >/dev/null 2>&1; then
    echo "  FAIL    should be REFUSED but was allowed: $1" >&2
    failures=$((failures + 1))
  else
    echo "  ok      refused: $1"
  fi
}

echo "allowed targets:"
allow "https://twh-staging.os.mieweb.org"
allow "https://twh-staging.os.mieweb.org/"     # trailing slash is equivalent
allow "http://localhost:3000"
allow "http://127.0.0.1:3000"

echo "refused targets:"
# THE reason this guard exists. Production returns 2xx, so a reachability check approves it.
refuse "https://twh.os.mieweb.org"
refuse "https://twh.os.mieweb.org/"
refuse "https://twh-api-ts.os.mieweb.org"
# A denylist of the two hosts above would let these through; an allowlist does not.
refuse "https://workwell.os.mieweb.org"
refuse "https://example.com"
# Prefix/suffix games against a naive matcher.
refuse "https://twh-staging.os.mieweb.org.evil.test"
refuse "https://evil.test/https://twh-staging.os.mieweb.org"
refuse "http://twh-staging.os.mieweb.org"      # scheme matters: staging is https
refuse "http://localhost"                       # no port — not the documented dev form
refuse ""

if [ "${failures}" -ne 0 ]; then
  echo "e2e-target-allowed.test.sh: ${failures} failure(s)" >&2
  exit 1
fi
echo "e2e-target-allowed.test.sh: all assertions passed"
