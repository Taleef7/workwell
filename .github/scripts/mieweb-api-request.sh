#!/usr/bin/env bash

# Shared request boundary for deploy-mieweb-container.sh. Callers provide
# api_base and MIEWEB_API_KEY. GET requests are safe to retry; state-changing
# requests are attempted once because a lost response is operationally
# ambiguous (the manager may already have applied the change).

is_transient_curl_exit() {
  case "$1" in
    5|6|7|18|28|52|55|56) return 0 ;;
    *) return 1 ;;
  esac
}

require_positive_request_integer() {
  local name="$1" value="$2"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::${name} must be a positive integer (got '${value}')." >&2
    return 1
  fi
}

request() {
  local method="$1"
  local path="$2"
  local body_file="${3:-}"
  local configured_attempts="${MIEWEB_REQUEST_ATTEMPTS:-6}"
  local retry_delay="${MIEWEB_REQUEST_RETRY_DELAY_SECONDS:-20}"
  local connect_timeout="${MIEWEB_REQUEST_CONNECT_TIMEOUT_SECONDS:-10}"
  local max_time="${MIEWEB_REQUEST_MAX_TIME_SECONDS:-30}"
  local attempts=1 response_file status curl_exit attempt

  require_positive_request_integer MIEWEB_REQUEST_ATTEMPTS "$configured_attempts" || return 1
  require_positive_request_integer MIEWEB_REQUEST_CONNECT_TIMEOUT_SECONDS "$connect_timeout" || return 1
  require_positive_request_integer MIEWEB_REQUEST_MAX_TIME_SECONDS "$max_time" || return 1
  if ! [[ "$retry_delay" =~ ^[0-9]+$ ]]; then
    echo "::error::MIEWEB_REQUEST_RETRY_DELAY_SECONDS must be a non-negative integer (got '${retry_delay}')." >&2
    return 1
  fi
  if [ "$method" = "GET" ]; then
    attempts="$configured_attempts"
  fi

  response_file="$(mktemp)"
  for attempt in $(seq 1 "$attempts"); do
    : > "$response_file"
    set +e
    if [ -n "$body_file" ]; then
      status=$(curl -sS --connect-timeout "$connect_timeout" --max-time "$max_time" \
        -o "$response_file" -w "%{http_code}" \
        -X "$method" "${api_base}${path}" \
        -H "Authorization: Bearer ${MIEWEB_API_KEY}" \
        -H "Accept: application/json" \
        -H "Content-Type: application/json" \
        --data-binary "@$body_file")
      curl_exit=$?
    else
      status=$(curl -sS --connect-timeout "$connect_timeout" --max-time "$max_time" \
        -o "$response_file" -w "%{http_code}" \
        -X "$method" "${api_base}${path}" \
        -H "Authorization: Bearer ${MIEWEB_API_KEY}" \
        -H "Accept: application/json")
      curl_exit=$?
    fi
    set -e

    if [ "$curl_exit" -ne 0 ]; then
      if [ "$method" = "GET" ] && is_transient_curl_exit "$curl_exit" && [ "$attempt" -lt "$attempts" ]; then
        echo "::warning::${method} ${path} transient failure (curl exit ${curl_exit}), attempt ${attempt}/${attempts}; retrying in ${retry_delay}s." >&2
        [ "$retry_delay" -gt 0 ] && sleep "$retry_delay"
        continue
      fi
      echo "::error::${method} ${path} failed before HTTP response (curl exit ${curl_exit}) after ${attempt} attempt(s)." >&2
      cat "$response_file" >&2 || true
      rm -f "$response_file"
      return 1
    fi

    if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
      echo "::error::${method} ${path} failed with HTTP ${status} after ${attempt} attempt(s)." >&2
      cat "$response_file" >&2
      rm -f "$response_file"
      return 1
    fi

    if [ "$status" = "204" ] || { [ "$method" = "DELETE" ] && [ ! -s "$response_file" ]; }; then
      rm -f "$response_file"
      return 0
    fi

    if ! jq -e . "$response_file" >/dev/null 2>&1; then
      echo "::error::${method} ${path} returned a non-JSON response from ${api_base}${path}." >&2
      echo "::error::Check LAUNCHPAD_API_URL. The web UI serves HTML at the origin and Swagger at /api; the JSON REST API is at /api/v1." >&2
      echo "Response preview:" >&2
      head -c 500 "$response_file" >&2 || true
      echo >&2
      rm -f "$response_file"
      return 1
    fi

    cat "$response_file"
    rm -f "$response_file"
    return 0
  done

  rm -f "$response_file"
  return 1
}
