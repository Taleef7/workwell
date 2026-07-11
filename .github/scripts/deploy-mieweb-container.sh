#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "::error::Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

for name in \
  MIEWEB_API_URL \
  MIEWEB_API_KEY \
  SITE_ID \
  CONTAINER_HOSTNAME \
  CONTAINER_IMAGE \
  INTERNAL_PORT \
  REPLACE_EXISTING \
  CONTAINER_ENV_VARS_JSON; do
  require_env "$name"
done

# Normalize whatever form LAUNCHPAD_API_URL takes down to the manager origin, then target
# the versioned JSON REST base. As of 2026-06 the MIE Container Manager serves:
#   - the SPA web UI at the origin (e.g. GET /sites returns index.html)
#   - the Swagger UI at /api
#   - the JSON REST API at /api/v1
# Strip any of these known suffixes if present, then re-append /api/v1 so the value is
# resilient to the secret being stored as the bare origin, /api, /v1, or /api/v1.
api_root="${MIEWEB_API_URL%/}"
api_root="${api_root%/api/v1}"
api_root="${api_root%/v1}"
api_root="${api_root%/api}"
api_base="${api_root}/api/v1"

request() {
  local method="$1"
  local path="$2"
  local body_file="${3:-}"
  local response_file status curl_exit
  response_file="$(mktemp)"

  set +e
  if [ -n "$body_file" ]; then
    status=$(curl -sS -o "$response_file" -w "%{http_code}" \
      -X "$method" "${api_base}${path}" \
      -H "Authorization: Bearer ${MIEWEB_API_KEY}" \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      --data-binary "@$body_file")
    curl_exit=$?
  else
    status=$(curl -sS -o "$response_file" -w "%{http_code}" \
      -X "$method" "${api_base}${path}" \
      -H "Authorization: Bearer ${MIEWEB_API_KEY}" \
      -H "Accept: application/json")
    curl_exit=$?
  fi
  set -e

  if [ "$curl_exit" -ne 0 ]; then
    echo "::error::${method} ${path} failed before HTTP response (curl exit ${curl_exit})" >&2
    cat "$response_file" >&2 || true
    return 1
  fi

  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "::error::${method} ${path} failed with HTTP ${status}" >&2
    cat "$response_file" >&2
    return 1
  fi

  if [ "$status" = "204" ] || { [ "$method" = "DELETE" ] && [ ! -s "$response_file" ]; }; then
    return 0
  fi

  if ! jq -e . "$response_file" >/dev/null 2>&1; then
    echo "::error::${method} ${path} returned a non-JSON response from ${api_base}${path}." >&2
    echo "::error::Check LAUNCHPAD_API_URL. The web UI serves HTML at the origin and Swagger at /api; the JSON REST API is at /api/v1." >&2
    echo "Response preview:" >&2
    head -c 500 "$response_file" >&2 || true
    echo >&2
    return 1
  fi

  cat "$response_file"
}

echo "$CONTAINER_ENV_VARS_JSON" | jq -e '
  type == "array" and all(.[]; type == "object" and has("key") and has("value"))
' >/dev/null

echo "Confirming site ${SITE_ID} exists..."
sites_json="$(request GET /sites)"
echo "$sites_json" | jq -e --argjson site_id "$SITE_ID" '.data[] | select(.id == $site_id)' >/dev/null

echo "Resolving external domain for site ${SITE_ID}..."
template_context="$(request GET "/sites/${SITE_ID}/containers/new")"
external_domain_id="$(
  echo "$template_context" |
    jq -r '([.data.externalDomains[] | select(.name == "os.mieweb.org") | .id] | first) // .data.externalDomains[0].id // empty'
)"
if [ -z "$external_domain_id" ] || [ "$external_domain_id" = "null" ]; then
  echo "::error::No external domain is available for site ${SITE_ID}." >&2
  exit 1
fi

existing_json="$(request GET "/sites/${SITE_ID}/containers?hostname=${CONTAINER_HOSTNAME}")"
existing_id="$(echo "$existing_json" | jq -r '.data[0].id // empty')"
if [ -n "$existing_id" ]; then
  if [ "$REPLACE_EXISTING" != "true" ]; then
    echo "::error::Container '${CONTAINER_HOSTNAME}' already exists as ID ${existing_id}. Re-run workflow_dispatch with replace_existing=true or merge to main intentionally." >&2
    exit 1
  fi
  echo "Deleting existing container '${CONTAINER_HOSTNAME}' (ID ${existing_id}) before recreate..."
  request DELETE "/sites/${SITE_ID}/containers/${existing_id}" >/dev/null
fi

payload_file="$(mktemp)"
jq -n \
  --arg hostname "$CONTAINER_HOSTNAME" \
  --arg image "$CONTAINER_IMAGE" \
  --argjson domain_id "$external_domain_id" \
  --argjson internal_port "$INTERNAL_PORT" \
  --argjson env_vars "$CONTAINER_ENV_VARS_JSON" \
  '{
    hostname: $hostname,
    template: $image,
    nvidiaRequested: false,
    services: [
      {
        type: "http",
        internalPort: $internal_port,
        externalHostname: $hostname,
        externalDomainId: $domain_id,
        authRequired: false
      }
    ],
    environmentVars: $env_vars
  }' > "$payload_file"

cleanup_existing_for_retry() {
  local retry_existing_json retry_existing_id
  retry_existing_json="$(request GET "/sites/${SITE_ID}/containers?hostname=${CONTAINER_HOSTNAME}" || echo '{}')"
  retry_existing_id="$(echo "$retry_existing_json" | jq -r '.data[0].id // empty')"
  if [ -n "$retry_existing_id" ]; then
    echo "Cleaning up container '${CONTAINER_HOSTNAME}' (ID ${retry_existing_id}) before retry..."
    request DELETE "/sites/${SITE_ID}/containers/${retry_existing_id}" >/dev/null || true
  fi
}

# Returns 0 on success, 2 on transient failure (caller may retry), 1 on permanent failure.
create_and_wait() {
  local create_json job_id job_json job_status status_log
  create_json="$(request POST "/sites/${SITE_ID}/containers" "$payload_file")"
  job_id="$(echo "$create_json" | jq -r '.data.jobId // .data.creationJobId // .data.id // .jobId // empty')"
  if [ -z "$job_id" ] || [ "$job_id" = "null" ]; then
    echo "::error::Create response did not include a job id." >&2
    echo "$create_json" >&2
    return 1
  fi

  # Default 90 × 10s = 900s. Overridable via DEPLOY_JOB_POLL_ATTEMPTS for slower/faster MIE pulls.
  # GHCR pull + vzcreate can exceed the old 300s window once the image grew (fqm-execution + official bundle).
  # Validate the override HARD: a non-numeric / 0 / negative / empty value would make `seq 1 "$poll_attempts"`
  # an empty loop, so the poll would return success WITHOUT ever checking the job — a broken deploy reported
  # green. Fail fast (a bad CI value must not silently proceed) and cap at 360 (60 min) so a fat-fingered huge
  # value can't outlast the MIE job's own timeout budget.
  local poll_attempts="${DEPLOY_JOB_POLL_ATTEMPTS:-90}"
  if ! [[ "$poll_attempts" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::DEPLOY_JOB_POLL_ATTEMPTS must be a positive integer (got '${poll_attempts}')." >&2
    exit 1
  fi
  if [ "$poll_attempts" -gt 360 ]; then
    echo "::error::DEPLOY_JOB_POLL_ATTEMPTS=${poll_attempts} exceeds the 360 (60 min) cap." >&2
    exit 1
  fi
  echo "Waiting for job ${job_id} (up to ${poll_attempts} attempts × 10s)..."
  for attempt in $(seq 1 "$poll_attempts"); do
    job_json="$(request GET "/jobs/${job_id}")"
    job_status="$(echo "$job_json" | jq -r '.data.status // .status // "unknown"')"
    echo "Attempt ${attempt}/${poll_attempts}: ${job_status}"
    case "$job_status" in
      success|completed)
        return 0
        ;;
      failure|failed|error|cancelled)
        echo "::error::Deploy job ${job_id} ended with status ${job_status}." >&2
        status_log="$(request GET "/jobs/${job_id}/status?limit=1000" 2>/dev/null || true)"
        echo "$status_log" >&2
        if echo "$status_log" | grep -qiE 'request timeout|fetching digest|econnrefused|enotfound|etimedout|eai_again|socket hang up|getaddrinfo|temporarily unavailable|503|502|504'; then
          echo "::warning::Detected transient MIE/registry error; this attempt is eligible for retry." >&2
          return 2
        fi
        return 1
        ;;
    esac
    if [ "$attempt" -eq "$poll_attempts" ]; then
      echo "::error::Timed out waiting for deploy job ${job_id}." >&2
      request GET "/jobs/${job_id}/status?limit=1000" >&2 || true
      return 2
    fi
    sleep 10
  done
}

echo "Creating container '${CONTAINER_HOSTNAME}' from ${CONTAINER_IMAGE}..."
max_create_attempts=3
create_result=1
for create_try in $(seq 1 "$max_create_attempts"); do
  if [ "$create_try" -gt 1 ]; then
    backoff=$(( 20 * (create_try - 1) ))
    echo "Retry ${create_try}/${max_create_attempts} after ${backoff}s backoff..."
    sleep "$backoff"
    cleanup_existing_for_retry
  fi
  set +e
  create_and_wait
  create_result=$?
  set -e
  if [ "$create_result" -eq 0 ]; then
    break
  fi
  if [ "$create_result" -eq 1 ]; then
    exit 1
  fi
done
if [ "$create_result" -ne 0 ]; then
  echo "::error::Container creation failed after ${max_create_attempts} attempts with transient errors." >&2
  exit 1
fi

# The create job reporting "success" means the container was provisioned, but it can still be
# transitioning (pending/offline/starting) for a few seconds before it reports "running". A single
# eager read therefore races startup and fails an otherwise-good deploy (observed: the container
# reached "running" on its own moments after the script gave up). Poll until "running" with a
# bounded timeout instead — mirrors the self-heal reconciler's retrying health check.
status_attempts=18 # ~3 min at 10s — comfortably longer than a normal cold start
container_status="unknown"
container_url=""
for status_attempt in $(seq 1 "$status_attempts"); do
  final_json="$(request GET "/sites/${SITE_ID}/containers?hostname=${CONTAINER_HOSTNAME}")"
  container_status="$(echo "$final_json" | jq -r '.data[0].status // "unknown"')"
  container_url="$(echo "$final_json" | jq -r '.data[0].httpEntries[0].externalUrl // empty')"
  echo "Container status attempt ${status_attempt}/${status_attempts}: ${container_status}"
  if [ "$container_status" = "running" ]; then
    break
  fi
  sleep 10
done
echo "Container status: ${container_status}"
echo "Container URL: ${container_url:-not reported yet}"
if [ "$container_status" != "running" ]; then
  echo "::error::Container is '${container_status}' after ${status_attempts} status checks (~3 min), expected running." >&2
  exit 1
fi
