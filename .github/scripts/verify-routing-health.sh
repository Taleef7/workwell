#!/usr/bin/env bash

# Does the backend that just deployed serve the routing its image was built with? (#768)
#
# Sourced: defines verify_routing_health. Executed: reads HEALTH_URL, EXPECTED_SHA, EXPECTED_OFFICIAL and
# EXPECTED_DERIVED from the environment and exits with its answer.
#
# WHY. `maui-latest` is the image the self-heal recreates from, so promoting an image is a claim that it
# can serve. The container reaching `running` (all deploy-mieweb-container.sh checks) does not say that:
# a router that refuses its routing still boots, answers /actuator/health 200, and returns 500 from every
# evaluating route. /health reports the routed ids and the router's problem count from the same boot check
# that raises OFFICIAL_ROUTING_MISCONFIGURED, so the deploy can refuse to promote what would not serve.
#
# The sha is waited for first: right after a deploy the old container can still be the one answering, and
# its routing says nothing about the new image. Once the new build answers, its routing is final for the
# process, so a wrong list or a non-zero problem count fails at once rather than after the wait.

# jq's raw output without a carriage return (a Windows jq writes CRLF, which would never equal a sha).
jq_raw() {
  jq -r "$@" | tr -d '\r'
}

# The comma list as one canonical string: trimmed, empties dropped, sorted, deduplicated.
canonical_ids() {
  printf '%s' "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | sort -u | paste -sd, - || true
}

# verify_routing_health HEALTH_URL EXPECTED_SHA EXPECTED_OFFICIAL EXPECTED_DERIVED
#   0: the expected build answers, routes exactly these ids, and the router reports no problem
#   1: anything else (the caller must not promote)
verify_routing_health() {
  local url="$1" sha="$2" official want_official derived want_derived attempt body served_sha problems
  want_official="$(canonical_ids "$3")"
  want_derived="$(canonical_ids "$4")"
  local attempts="${ROUTING_HEALTH_ATTEMPTS:-30}" delay="${ROUTING_HEALTH_DELAY_SECONDS:-10}"
  for attempt in $(seq 1 "$attempts"); do
    body="$(curl -fsS --max-time 20 "$url" 2>/dev/null)" || body=""
    served_sha="$(printf '%s' "$body" | jq_raw '.build.sha // empty' 2>/dev/null || true)"
    if [ -n "$served_sha" ] && [ "$served_sha" = "$sha" ]; then
      if ! printf '%s' "$body" | jq -e '.routing | type == "object"' > /dev/null 2>&1; then
        echo "::error::${url} answers build ${sha} but reports no routing; refusing to promote an image that cannot say what it serves" >&2
        return 1
      fi
      problems="$(printf '%s' "$body" | jq_raw '.routing.problems')"
      official="$(canonical_ids "$(printf '%s' "$body" | jq_raw '.routing.official | join(",")')")"
      derived="$(canonical_ids "$(printf '%s' "$body" | jq_raw '.routing.derived | join(",")')")"
      if [ "$problems" != "0" ]; then
        echo "::error::build ${sha} reports ${problems} routing problem(s): the router refuses its routing (grep the container log for OFFICIAL_ROUTING_MISCONFIGURED)" >&2
        return 1
      fi
      if [ "$official" != "$want_official" ] || [ "$derived" != "$want_derived" ]; then
        echo "::error::build ${sha} routes official=[${official}] derived=[${derived}]; its build args say official=[${want_official}] derived=[${want_derived}]" >&2
        return 1
      fi
      echo "build ${sha} serves its routing: official=[${official}] derived=[${derived}], 0 problems (attempt ${attempt})"
      return 0
    fi
    [ "$attempt" -lt "$attempts" ] && sleep "$delay"
  done
  echo "::error::${url} never answered as build ${sha} (last answer: ${served_sha:-none}) within ${attempts} attempts" >&2
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  verify_routing_health "${HEALTH_URL:?}" "${EXPECTED_SHA:?}" "${EXPECTED_OFFICIAL:-}" "${EXPECTED_DERIVED:-}"
fi
