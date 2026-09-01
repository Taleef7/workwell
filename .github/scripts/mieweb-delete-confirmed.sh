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

# Three-valued on purpose, because "still there" and "could not tell" must lead to different actions:
#   0 = confirmed ABSENT      (a successful read reported no container for this hostname)
#   1 = confirmed PRESENT     (a successful read reported one; its id is in CONFIRMED_CONTAINER_ID)
#   2 = COULD NOT TELL        (the read itself failed)
# Collapsing 2 into 1 is what makes a helper like this dangerous rather than useful: the caller would
# re-issue a DELETE into a state it cannot see, which is the ambiguity the whole file exists to
# respect, and could target an id the manager has since reused for a different container.
# Collapsing 2 into 0 is worse still -- the caller would create over a container that is still running.
CONFIRMED_CONTAINER_ID=""
wait_for_container_absent() {
  local hostname="$1"
  local attempts="${MIEWEB_DELETE_CONFIRM_ATTEMPTS:-6}"
  local delay="${MIEWEB_DELETE_CONFIRM_DELAY_SECONDS:-10}"
  local attempt id last_read="unknown"
  CONFIRMED_CONTAINER_ID=""

  for attempt in $(seq 1 "$attempts"); do
    if id="$(container_id_for_hostname "$hostname")"; then
      if [ -z "$id" ]; then
        return 0
      fi
      last_read="present"
      CONFIRMED_CONTAINER_ID="$id"
      echo "Container '${hostname}' is still registered as ID ${id} (check ${attempt}/${attempts})." >&2
    else
      # A transient read failure is retried inside this window rather than being decisive; only the
      # LAST observation decides, so a manager that is unreachable at the end of the window yields 2.
      last_read="unknown"
      CONFIRMED_CONTAINER_ID=""
      echo "::warning::Could not read the container list while confirming deletion of '${hostname}' (check ${attempt}/${attempts})." >&2
    fi
    if [ "$attempt" -lt "$attempts" ] && [ "$delay" -gt 0 ]; then
      sleep "$delay"
    fi
  done

  [ "$last_read" = "present" ] && return 1
  return 2
}

# delete_container_confirmed <hostname> <container_id>
# Exit 0 when the container is gone -- whether the DELETE said so or the manager did.
delete_container_confirmed() {
  local hostname="$1" container_id="$2"
  local attempts="${MIEWEB_DELETE_ATTEMPTS:-3}"
  local attempt delete_exit confirm_result

  require_positive_request_integer MIEWEB_DELETE_ATTEMPTS "$attempts" || return 1
  require_positive_request_integer MIEWEB_DELETE_CONFIRM_ATTEMPTS "${MIEWEB_DELETE_CONFIRM_ATTEMPTS:-6}" || return 1

  for attempt in $(seq 1 "$attempts"); do
    set +e
    request DELETE "/sites/${SITE_ID}/containers/${container_id}" >/dev/null
    delete_exit=$?
    set -e
    if [ "$delete_exit" -eq 0 ]; then
      return 0
    fi

    echo "::warning::DELETE of '${hostname}' (ID ${container_id}) did not return cleanly on attempt ${attempt}/${attempts}; reading the manager back to find out whether it applied anyway." >&2
    set +e
    wait_for_container_absent "$hostname"
    confirm_result=$?
    set -e

    case "$confirm_result" in
      0)
        echo "::notice::'${hostname}' is gone -- the manager applied the delete despite the failed response. Continuing." >&2
        return 0
        ;;
      2)
        echo "::error::DELETE of '${hostname}' failed AND the manager could not be read back, so whether it applied is unknown." >&2
        echo "::error::Refusing to re-issue: a blind state-changing retry could delete a container recreated under a reused id. Wait for manager.os.mieweb.org to recover, confirm the container's state, then rerun this workflow." >&2
        return 1
        ;;
    esac

    # Confirmed still registered, so the request demonstrably did not take effect and re-issuing is
    # not blind. Re-target the id the manager itself just reported, in case it moved under us.
    container_id="$CONFIRMED_CONTAINER_ID"
  done

  echo "::error::Could not confirm deletion of '${hostname}' after ${attempts} attempt(s); it is still registered with the manager." >&2
  return 1
}
