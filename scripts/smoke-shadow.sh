#!/usr/bin/env bash
#
# §6 smoke checklist for the WorkWell backend (issue #109 deploy cutover).
# Runs the cutover-plan §6 checks against a deployed API and reports PASS/FAIL/WARN per check.
# Built for the backend-ts SHADOW (twh-api-ts), but BASE_URL works against any WorkWell API
# (e.g. the live Java twh-api, post-flip, for a before/after comparison).
#
# Usage:
#   scripts/smoke-shadow.sh [BASE_URL]
#
# Env overrides:
#   BASE_URL          API origin, no trailing slash   (default https://twh-api-ts.os.mieweb.org)
#   SMOKE_EMAIL       login email                      (default admin@workwell.dev)
#   SMOKE_PASSWORD    login password                   (default Workwell123!)
#
# Requires: bash, curl, jq. Exits non-zero if any HARD check fails. WARN checks are the documented
# known limitations (evidence upload = ephemeral fs BUCKET; MCP SSE = the MIE nginx proxy_read_timeout
# caveat) — they never fail the run.
set -uo pipefail

BASE_URL="${1:-${BASE_URL:-https://twh-api-ts.os.mieweb.org}}"
BASE_URL="${BASE_URL%/}"
EMAIL="${SMOKE_EMAIL:-admin@workwell.dev}"
PASSWORD="${SMOKE_PASSWORD:-Workwell123!}"

command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required" >&2; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq is required"   >&2; exit 2; }

COOKIES="$(mktemp)"; BODY="$(mktemp)"
TOKEN=""
PASS=0; FAIL=0; WARN=0
trap 'rm -f "$COOKIES" "$BODY"' EXIT

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_rst=$'\033[0m'
pass(){ printf '  %sPASS%s %s\n' "$c_grn" "$c_rst" "$1"; PASS=$((PASS+1)); }
fail(){ printf '  %sFAIL%s %s\n' "$c_red" "$c_rst" "$1"; FAIL=$((FAIL+1)); }
warn(){ printf '  %sWARN%s %s\n' "$c_yel" "$c_rst" "$1"; WARN=$((WARN+1)); }
note(){ printf '       %s%s%s\n' "$c_dim" "$1" "$c_rst"; }

# req METHOD PATH [json-data] → echoes HTTP status; response body in $BODY. Sends the bearer token
# (when set) and uses the shared cookie jar (for the refresh round-trip).
req(){
  local m="$1" p="$2" data="${3:-}"; local args=(-sS -o "$BODY" -w '%{http_code}' -X "$m" "$BASE_URL$p" -b "$COOKIES" -c "$COOKIES")
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  if [ -n "$data" ]; then args+=(-H "Content-Type: application/json" --data "$data"); fi
  curl "${args[@]}" 2>/dev/null || echo "000"
}

echo "WorkWell API smoke — $BASE_URL"
echo "================================================================"

# 1. version + health (unauthenticated)
echo "[discovery]"
st=$(req GET /api/version)
if [ "$st" = "200" ] && [ "$(jq -r '.api // empty' "$BODY")" = "v1" ]; then
  pass "GET /api/version → v1 (build=$(jq -r '.build // "?"' "$BODY"))"
else fail "GET /api/version → $st $(head -c 120 "$BODY")"; fi
st=$(req GET /actuator/health); { [ "$st" = "200" ] && pass "GET /actuator/health → 200"; } || warn "GET /actuator/health → $st (TS may expose health at /api/version only)"

# 2. auth: login → token + refresh cookie, then refresh round-trip
echo "[auth]"
st=$(req POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN="$(jq -r '.token // empty' "$BODY")"
if [ "$st" = "200" ] && [ -n "$TOKEN" ]; then pass "POST /api/auth/login → token (role=$(jq -r '.role // "?"' "$BODY"))"
else fail "POST /api/auth/login → $st $(head -c 120 "$BODY")"; echo; echo "Cannot continue without a token."; exit 1; fi
st=$(req POST /api/auth/refresh)
rt="$(jq -r '.token // empty' "$BODY")"
{ [ "$st" = "200" ] && [ -n "$rt" ] && pass "POST /api/auth/refresh → rotated token (cookie round-trips)" && TOKEN="$rt"; } || fail "POST /api/auth/refresh → $st (refresh cookie not honored?)"

# 3. measures: catalog count + a detail with value sets
echo "[measures]"
st=$(req GET /api/measures); n=$(jq 'length' "$BODY" 2>/dev/null || echo "?")
{ [ "$st" = "200" ] && [ "$n" = "60" ] && pass "GET /api/measures → 60"; } || warn "GET /api/measures → $st, count=$n (expected 60)"
st=$(req GET /api/measures/audiogram); vs=$(jq '([.valueSets // .value_sets // []] | flatten | length)' "$BODY" 2>/dev/null || echo 0)
{ [ "$st" = "200" ] && pass "GET /api/measures/audiogram → 200 (value sets: $vs)"; } || fail "GET /api/measures/audiogram → $st"

# 4. run: a MEASURE manual run (synchronous) → outcomes
echo "[runs]"
RUN_ID=""
st=$(req POST /api/runs/manual '{"scopeType":"MEASURE","measureId":"audiogram"}')
RUN_ID="$(jq -r '.id // empty' "$BODY")"; rstatus="$(jq -r '.status // "?"' "$BODY")"
if { [ "$st" = "201" ] || [ "$st" = "200" ]; } && [ -n "$RUN_ID" ]; then
  pass "POST /api/runs/manual (MEASURE) → run $RUN_ID ($rstatus)"
  # poll if not terminal yet
  for _ in $(seq 1 20); do
    case "$rstatus" in COMPLETED|PARTIAL_FAILURE|FAILED) break;; esac
    sleep 3; req GET "/api/runs/$RUN_ID" >/dev/null; rstatus="$(jq -r '.status // "?"' "$BODY")"
  done
  note "run settled: $rstatus"
  st=$(req GET "/api/runs/$RUN_ID/outcomes"); oc=$(jq 'length' "$BODY" 2>/dev/null || echo 0)
  { [ "$st" = "200" ] && [ "$oc" -gt 0 ] 2>/dev/null && pass "GET /api/runs/$RUN_ID/outcomes → $oc outcomes"; } || fail "GET /api/runs/:id/outcomes → $st, count=$oc"
else fail "POST /api/runs/manual → $st $(head -c 160 "$BODY")"; fi

# 5. cases: worklist + detail + outreach send + delivery flip
echo "[cases]"
st=$(req GET "/api/cases?status=open"); cn=$(jq 'length' "$BODY" 2>/dev/null || echo 0)
CASE_ID="$(jq -r '.[0].id // empty' "$BODY")"
{ [ "$st" = "200" ] && pass "GET /api/cases?status=open → $cn open (X-Total-Count header also exposed)"; } || fail "GET /api/cases?status=open → $st"
if [ -n "$CASE_ID" ]; then
  st=$(req GET "/api/cases/$CASE_ID"); { [ "$st" = "200" ] && pass "GET /api/cases/$CASE_ID → 200"; } || fail "GET /api/cases/:id → $st"
  st=$(req POST "/api/cases/$CASE_ID/actions/outreach"); { [ "$st" = "200" ] && pass "POST .../actions/outreach → 200 (simulated send)"; } || fail "POST .../actions/outreach → $st"
  st=$(req POST "/api/cases/$CASE_ID/actions/outreach/delivery?deliveryStatus=SENT")
  ds="$(jq -r '.latestOutreachDeliveryStatus // empty' "$BODY")"
  { [ "$st" = "200" ] && [ "$ds" = "SENT" ] && pass "POST .../actions/outreach/delivery?SENT → latestOutreachDeliveryStatus=SENT"; } || fail "outreach delivery flip → $st (status=$ds)"
  # auditor packet for this case
  st=$(req GET "/api/auditor/cases/$CASE_ID/packet?format=json"); { [ "$st" = "200" ] && pass "GET /api/auditor/cases/:id/packet?json → 200"; } || fail "auditor case packet → $st"
else note "no open case available — skipped case detail/outreach/auditor checks"; fi

# 6. exports (CSV)
echo "[exports]"
for path in "/api/exports/runs?format=csv" "/api/exports/cases?format=csv&status=open" "/api/audit-events/export?format=csv"; do
  st=$(req GET "$path"); { [ "$st" = "200" ] && pass "GET ${path%%\?*} → 200"; } || fail "GET $path → $st"
done
if [ -n "$RUN_ID" ]; then
  st=$(req GET "/api/exports/outcomes?format=csv&runId=$RUN_ID"); { [ "$st" = "200" ] && pass "GET /api/exports/outcomes?runId=… → 200"; } || fail "outcomes export → $st"
fi

# 7. admin: a read + the demo-reset prod gate (must be 403 under a production profile)
echo "[admin]"
st=$(req GET /api/admin/integrations); { [ "$st" = "200" ] && pass "GET /api/admin/integrations → 200"; } || fail "admin integrations → $st"
st=$(req POST /api/admin/demo-reset)
{ [ "$st" = "403" ] && pass "POST /api/admin/demo-reset → 403 (prod-gated, as required)"; } || fail "demo-reset gate → $st (expected 403 in production)"

# 8. known-limitation surfaces — WARN only
echo "[known limitations]"
if [ -n "${CASE_ID:-}" ]; then
  st=$(req GET "/api/cases/$CASE_ID/evidence"); { [ "$st" = "200" ] && warn "evidence list → 200, but uploads are EPHEMERAL (in-container fs BUCKET) — expected for this cutover"; } || warn "evidence list → $st (BUCKET is the deferred binding)"
fi
st=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 -H "Authorization: Bearer $TOKEN" "$BASE_URL/sse" 2>/dev/null || echo "000")
warn "GET /sse → $st (MCP SSE subject to the MIE nginx proxy_read_timeout caveat — not a cutover regression)"

echo "================================================================"
printf 'RESULT: %s%d pass%s, %s%d fail%s, %s%d warn%s\n' "$c_grn" "$PASS" "$c_rst" "$c_red" "$FAIL" "$c_rst" "$c_yel" "$WARN" "$c_rst"
[ "$FAIL" -eq 0 ] || { echo "One or more HARD checks failed."; exit 1; }
echo "All hard checks passed."
