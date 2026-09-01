#!/usr/bin/env bash

# Confirmed container deletion for deploy-mieweb-container.sh.
#
# Requires `request()` from mieweb-api-request.sh, plus SITE_ID and api_base, to be in scope.
#
# WHY THIS EXISTS. Twice — 2026-08-30 and 2026-09-01 — a production deploy failed at
# `DELETE /sites/1/containers/<id>` with `curl: (28)` after 30s and zero bytes, and the manager had
# ALREADY APPLIED THE DELETION. The deploy then aborted before recreating, so the live backend was
# gone and the frontend was left on the previous image.
#
# mieweb-api-request.sh attempts a state-changing request exactly once, and that policy is right: a
# lost response means the manager's state is unknown, and blindly re-issuing into an unknown state is
# the worse default. But "unknown" was never where this had to end. The manager will say what is
# true — so ASK IT, instead of failing a deploy over an ambiguity that one GET resolves.
#
# The rule below, therefore: never re-issue a DELETE on the strength of a failed response alone;
# re-issue only after reading back that the container is demonstrably still there, at which point the
# request provably did not take effect and there is no ambiguity left to respect.

# Echo the container id currently registered for a hostname; empty when none is.
# Exit 1 means "could not tell" — a failed or unparseable list read — which is NOT the same as
# "absent" and must never be collapsed into it (see wait_for_container_absent).
container_id_for_hostname() {
  local hostname="$1" json
  set +e
  json="$(request GET "/sites/${SITE_ID}/containers?hostname=${hostname}")"
  local request_exit=$?
  set -e
  [ "$request_exit" -eq 0 ] || return 1
  [ -n "$json" ] || return 1
  printf '%s' "$json" | jq -r '.data[0].id // empty'
}

# Exit 0 only when the manager has AFFIRMATIVELY reported the hostname absent. A list read that
# fails is reported as still-present, because a manager we cannot reach is exactly when a false
# "it's gone" would do the most damage: the caller would proceed to create over a container that is
# still running.
wait_for_container_absent() {
  local hostname="$1"
  local attempts="${MIEWEB_DELETE_CONFIRM_ATTEMPTS:-6}"
  local delay="${MIEWEB_DELETE_CONFIRM_DELAY_SECONDS:-10}"
  local attempt id

  require_positive_request_integer MIEWEB_DELETE_CONFIRM_ATTEMPTS "$attempts" || return 1

  for attempt in $(seq 1 "$attempts"); do
    if id="$(container_id_for_hostname "$hostname")"; then
      if [ -z "$id" ]; then
        return 0
      fi
      echo "Container '${hostname}' is still registered as ID ${id} (check ${attempt}/${attempts})." >&2
    else
      echo "::warning::Could not read the container list while confirming deletion of '${hostname}' (check ${attempt}/${attempts}); treating as still-present." >&2
    fi
    if [ "$attempt" -lt "$attempts" ] && [ "$delay" -gt 0 ]; then
      sleep "$delay"
    fi
  done
  return 1
}

# delete_container_confirmed <hostname> <container_id>
# Exit 0 when the container is gone — whether the DELETE said so or the manager did.
delete_container_confirmed() {
  local hostname="$1" container_id="$2"
  local attempts="${MIEWEB_DELETE_ATTEMPTS:-3}"
  local attempt delete_exit refreshed

  require_positive_request_integer MIEWEB_DELETE_ATTEMPTS "$attempts" || return 1

  for attempt in $(seq 1 "$attempts"); do
    set +e
    request DELETE "/sites/${SITE_ID}/containers/${container_id}" >/dev/null
    delete_exit=$?
    set -e
    if [ "$delete_exit" -eq 0 ]; then
      return 0
    fi

    echo "::warning::DELETE of '${hostname}' (ID ${container_id}) did not return cleanly on attempt ${attempt}/${attempts}; reading the manager back to find out whether it applied anyway." >&2
    if wait_for_container_absent "$hostname"; then
      echo "::notice::'${hostname}' is gone — the manager applied the delete despite the failed response. Continuing." >&2
      return 0
    fi

    # Still registered, so the request demonstrably did not take effect. Re-target in case the id
    # moved under us, then re-issue: this is no longer a blind retry into an unknown state.
    if refreshed="$(container_id_for_hostname "$hostname")" && [ -n "$refreshed" ]; then
      container_id="$refreshed"
    fi
  done

  echo "::error::Could not confirm deletion of '${hostname}' after ${attempts} attempt(s); it is still registered with the manager." >&2
  return 1
}
