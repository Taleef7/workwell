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

api_root="${MIEWEB_API_URL%/}"
if [[ "$api_root" == */api ]]; then
  # /api is the Swagger UI route; the JSON endpoints are served from the manager origin.
  api_base="${api_root%/api}"
else
  api_base="$api_root"
fi

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
    echo "::error::Check LAUNCHPAD_API_URL. The Swagger UI lives at /api, but REST requests must target the manager origin." >&2
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
echo "$sites_json" | jq -e --argjson site_id "$SITE_ID" '.sites[] | select(.id == $site_id)' >/dev/null

echo "Resolving external domain for site ${SITE_ID}..."
template_context="$(request GET "/sites/${SITE_ID}/containers/new")"
external_domain_id="$(
  echo "$template_context" |
    jq -r '([.domains[] | select(.name == "os.mieweb.org") | .id] | first) // .domains[0].id // empty'
)"
if [ -z "$external_domain_id" ] || [ "$external_domain_id" = "null" ]; then
  echo "::error::No external domain is available for site ${SITE_ID}." >&2
  exit 1
fi

existing_json="$(request GET "/sites/${SITE_ID}/containers?hostname=${CONTAINER_HOSTNAME}")"
existing_id="$(echo "$existing_json" | jq -r '.containers[0].id // empty')"
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
    template_name: $image,
    services: {
      web: {
        type: "http",
        internalPort: $internal_port,
        externalHostname: $hostname,
        externalDomainId: $domain_id,
        authRequired: false
      }
    },
    environmentVars: $env_vars,
    nvidiaRequested: false
  }' > "$payload_file"

echo "Creating container '${CONTAINER_HOSTNAME}' from ${CONTAINER_IMAGE}..."
create_json="$(request POST "/sites/${SITE_ID}/containers" "$payload_file")"
job_id="$(echo "$create_json" | jq -r '.jobId // empty')"
if [ -z "$job_id" ] || [ "$job_id" = "null" ]; then
  echo "::error::Create response did not include jobId." >&2
  echo "$create_json" >&2
  exit 1
fi

echo "Waiting for job ${job_id}..."
for attempt in $(seq 1 30); do
  job_json="$(request GET "/jobs/${job_id}")"
  job_status="$(echo "$job_json" | jq -r '.status // "unknown"')"
  echo "Attempt ${attempt}/30: ${job_status}"
  case "$job_status" in
    success|completed)
      break
      ;;
    failure|failed|error|cancelled)
      echo "::error::Deploy job failed with status ${job_status}." >&2
      request GET "/jobs/${job_id}/status?limit=1000" >&2 || true
      exit 1
      ;;
  esac
  if [ "$attempt" -eq 30 ]; then
    echo "::error::Timed out waiting for deploy job." >&2
    request GET "/jobs/${job_id}/status?limit=1000" >&2 || true
    exit 1
  fi
  sleep 10
done

final_json="$(request GET "/sites/${SITE_ID}/containers?hostname=${CONTAINER_HOSTNAME}")"
container_status="$(echo "$final_json" | jq -r '.containers[0].status // "unknown"')"
container_url="$(echo "$final_json" | jq -r '.containers[0].httpExternalUrl // empty')"
echo "Container status: ${container_status}"
echo "Container URL: ${container_url:-not reported yet}"
if [ "$container_status" != "running" ]; then
  echo "::error::Container is '${container_status}', expected running." >&2
  exit 1
fi
