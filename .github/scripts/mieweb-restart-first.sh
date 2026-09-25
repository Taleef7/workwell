#!/usr/bin/env bash

# Restart-first self-heal (#663).
#
# Sourced: requires request() (mieweb-api-request.sh), container_id_for_hostname
# (mieweb-delete-confirmed.sh), SITE_ID and api_base in scope. Executed: normalizes the manager URL the
# way deploy-mieweb-container.sh does and restarts CONTAINER_HOSTNAME.
#
# WHY. The reconciler's heal was always delete + recreate. On 2026-09-22 that ended a 29-minute hang
# of the Maui API and destroyed the only record of what caused it. A restart-only request
# (`PUT /sites/{site}/containers/{id}` with `{"restart": true}` and nothing else) restarts the container
# in place: same image, same env, same disk. So the report the runtime monitor writes during a long
# stall (`var/stall-evidence.json`) is still there, and the next boot shows it on /api/admin/runtime.
# If the restart cannot be requested, or the surface is still down afterwards, the caller recreates
# exactly as before.
#
# The body carries `restart` ONLY. The manager treats a request with any other field as a config
# update, and an omitted `environmentVars` or `entrypoint` then CLEARS them; restart-only is the one
# shape that leaves the container's configuration alone.

# restart_in_place HOSTNAME HEALTH_URL EXPECT
#   0: restarted in place and healthy (the caller skips the recreate)
#   1: could not restart, or still unhealthy after the wait (the caller recreates)
restart_in_place() {
  local hostname="$1" url="$2" expect="$3" id body_file attempt body
  local attempts="${MIEWEB_RESTART_HEALTH_ATTEMPTS:-12}" delay="${MIEWEB_RESTART_HEALTH_DELAY_SECONDS:-20}"
  if ! id="$(container_id_for_hostname "$hostname")"; then
    echo "::warning::could not read which container is ${hostname}; falling back to recreate" >&2
    return 1
  fi
  if [ -z "$id" ]; then
    echo "::warning::no container is registered for ${hostname}; nothing to restart" >&2
    return 1
  fi
  body_file="$(mktemp)"
  printf '{"restart":true}' > "$body_file"
  # One attempt: a restart that times out at the client may still have been applied, and a second
  # request would only restart it again. A FAILED request is therefore not a verdict (Codex on #708):
  # mieweb-api-request.sh treats a lost response to a state-changing call as ambiguous, and giving up
  # here would recreate the container, deleting the stall report, after a restart that did happen.
  # The health wait below decides either way; it only costs the wait when the request truly failed.
  if ! MIEWEB_REQUEST_ATTEMPTS=1 request PUT "/sites/${SITE_ID}/containers/${id}" "$body_file" >/dev/null; then
    echo "::warning::the restart request for ${hostname} did not confirm; waiting on health in case it was applied" >&2
  fi
  rm -f "$body_file"
  for attempt in $(seq 1 "$attempts"); do
    if [ "$delay" -gt 0 ]; then sleep "$delay"; fi
    if body="$(curl -fsS --max-time 15 "$url" 2>/dev/null)" && printf '%s' "$body" | grep -q "$expect"; then
      echo "✓ ${hostname} restarted in place and is healthy (check ${attempt}/${attempts})"
      return 0
    fi
  done
  echo "::warning::${hostname} is still unhealthy after an in-place restart; falling back to recreate" >&2
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  for name in MIEWEB_API_URL MIEWEB_API_KEY SITE_ID CONTAINER_HOSTNAME HEALTH_URL HEALTH_EXPECT; do
    if [ -z "${!name:-}" ]; then
      echo "::error::Missing required environment variable: ${name}" >&2
      exit 1
    fi
  done
  # Same normalization as deploy-mieweb-container.sh: the manager serves the JSON API at /api/v1.
  api_root="${MIEWEB_API_URL%/}"
  api_root="${api_root%/api/v1}"
  api_root="${api_root%/v1}"
  api_root="${api_root%/api}"
  api_base="${api_root}/api/v1"
  # shellcheck source=mieweb-api-request.sh
  source "$(dirname "${BASH_SOURCE[0]}")/mieweb-api-request.sh"
  # shellcheck source=mieweb-delete-confirmed.sh
  source "$(dirname "${BASH_SOURCE[0]}")/mieweb-delete-confirmed.sh"
  restart_in_place "$CONTAINER_HOSTNAME" "$HEALTH_URL" "$HEALTH_EXPECT"
fi
