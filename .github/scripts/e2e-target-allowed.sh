#!/usr/bin/env bash
# Decides whether a URL may be used as the Playwright E2E target.
#
#   bash .github/scripts/e2e-target-allowed.sh <url>     # exit 0 = allowed, 1 = refused (+ reason on stderr)
#
# ## Why this is an ALLOWLIST and not a production denylist
#
# The E2E suite MUTATES: `runs.spec.ts` triggers a manual run and `case-outreach.spec.ts` POSTs
# `/actions/outreach`. Under CLAUDE.md's hard rule every one of those writes an `audit_event`, and even
# the suite's repeated logins create and rotate refresh-token-family state. Pointed at production it
# would write real runs, real case actions and real audit rows.
#
# The first cut guarded this with a warning in the workflow input's description and a reachability check
# that approved ANY 2xx origin — so the documented production host passed it. A description is not an
# enforcement mechanism (review, #407).
#
# A denylist of known production hosts is the obvious fix and the wrong one: it has to enumerate every
# origin that must never be hit — `twh.os.mieweb.org`, `twh-api-ts.os.mieweb.org`, whatever is added
# next — and a host nobody remembered to add is silently permitted. An allowlist fails CLOSED: a target
# nobody has thought about is refused, and adding one is a reviewed edit to this file.
set -euo pipefail

url="${1:-}"

if [ -z "${url}" ]; then
  echo "e2e-target-allowed: no URL given" >&2
  exit 1
fi

# Trailing slashes are equivalent; normalise so `…org` and `…org/` behave the same.
url="${url%/}"

case "${url}" in
  # The staging stack, provisioned by deploy-staging-mieweb.yml. The only shared environment this
  # suite may write to.
  https://twh-staging.os.mieweb.org) exit 0 ;;
  # A developer's own machine — nothing shared, nothing auditable by anyone else.
  http://localhost:[0-9]*|http://127.0.0.1:[0-9]*) exit 0 ;;
esac

cat >&2 <<EOF
e2e-target-allowed: refusing '${url}'.

The E2E suite MUTATES — it triggers runs and POSTs outreach, and every state change writes an
audit_event. It may only run against a target on the allowlist in this script:

  https://twh-staging.os.mieweb.org
  http://localhost:<port>  /  http://127.0.0.1:<port>

Production (twh.os.mieweb.org and friends) is refused BY DESIGN, not by omission. If a new environment
genuinely needs to be a target, add it here so the addition is reviewed.
EOF
exit 1
