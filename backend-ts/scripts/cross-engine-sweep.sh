#!/usr/bin/env bash
#
# Drive one cross-engine sweep end to end: a FRESH `cqf-fhir-cr` container, the measure bundle loaded,
# then `cross-engine-check.ts` against it.
#
#     scripts/cross-engine-sweep.sh cms2 [--bundle path/to/mutated-bundle.json] [--keep] [-- <check args>]
#
# Why a script rather than a runbook. Three of the four ways to get this wrong are silent, and each cost
# an afternoon once (`docs/evidence/CROSS_ENGINE_2026-08-04.md`, `..._2026-09-06_CMS137.md`):
#
#   1. `$evaluate-measure` CACHES per subject for the life of the server. A second sweep against a changed
#      input returns the PREVIOUS answer, byte-identical, with no warning. So every run here starts by
#      destroying the container — there is no reuse path, and `--keep` only defers the teardown so the
#      server can be inspected after a run, never reused for another.
#   2. `/metadata` answers 200 BEFORE the Clinical Reasoning module registers its operations, so a load
#      that races it evaluates against a server that "declares no evaluate-measure". This waits for the
#      capability statement to actually name the operation, then lets it settle.
#   3. `hapi.fhir.cr.enabled` is the property; `cr_enabled` starts a healthy server that silently declares
#      no measure operations. Spelled once, here.
#   4. Terminology must be pushed BEFORE the first evaluation (`--load-terminology`, which the check
#      script does up front for that reason). Passed through by default.
#
# `--bundle` overrides the upstream bundle with a mutated copy, which is how a hypothesis gets isolated
# under ADR-055's standard: one variable changed, a fresh container, everything else identical.
set -euo pipefail

MEASURE="${1:-}"
if [[ -z "$MEASURE" ]]; then
  echo "usage: scripts/cross-engine-sweep.sh <measureId> [--bundle FILE] [--keep] [-- <cross-engine-check args>]" >&2
  exit 2
fi
shift

BUNDLE_OVERRIDE=""
KEEP=0
CHECK_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE_OVERRIDE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --) shift; CHECK_ARGS=("$@"); break ;;
    *) CHECK_ARGS+=("$1"); shift ;;
  esac
done

CONTAINER="${HAPI_CONTAINER:-hapi-cr}"
PORT="${HAPI_PORT:-8899}"
IMAGE="${HAPI_IMAGE:-hapiproject/hapi:latest}"
BASE="http://localhost:${PORT}/fhir"
CONTENT="${CROSS_ENGINE_CONTENT:-.official-content}"

# Prefer the pnpm already on PATH. In CI that is the version `pnpm/action-setup` pinned (10.17.1), and
# bare `corepack pnpm` IGNORES that pin: it fetches the latest pnpm, which on the first real run of this
# workflow downloaded 12.3.4 and died with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH before the sweep started.
# `corepack pnpm@10` is the fallback for a developer machine where pnpm is not on PATH — pinned to the
# major the lockfile was written by, for the same reason.
#
# Deliberately unquoted where it is used: the fallback is TWO words, and quoting it would look for a
# program of that name. Override with PNPM_CMD for a different launcher.
# shellcheck disable=SC2086
# The PATH pnpm is used only if it is the MAJOR the lockfile was written by. Preferring it unchecked
# just moves the bug: a workstation with a global pnpm 12 would fail with the same
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH this exists to fix, and would never reach the fallback that works
# (review finding). PNPM_CMD overrides everything, and must not contain a path with spaces — it is
# expanded unquoted, because the fallback is two words.
if [[ -n "${PNPM_CMD:-}" ]]; then
  PNPM="$PNPM_CMD"
elif command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version 2>/dev/null)" == 10.* ]]; then
  PNPM="pnpm"
else
  PNPM="corepack pnpm@10"
fi

# The bundle directory name is the artifact's own name; ask the module that owns the mapping rather than
# duplicating a nine-entry table that would drift on the tenth measure.
# The id is passed through the ENVIRONMENT, never interpolated into the snippet: a measure id with a
# quote in it would otherwise be spliced into the source text rather than read as a value.
NAME="$(SWEEP_MEASURE="$MEASURE" $PNPM exec tsx -e "import {officialMeasureName} from './src/standards/official-cases.ts'; process.stdout.write(officialMeasureName(process.env.SWEEP_MEASURE ?? '') ?? '')")"
if [[ -z "$NAME" ]]; then
  echo "cross-engine-sweep: '${MEASURE}' is not an official measure id" >&2
  exit 2
fi

# Checked here, before anything is started: the bundle-load verification below is not optional. Guarded
# on `command -v jq` it would simply VANISH on a host without jq — a safety check that disappears
# exactly where nobody notices, which is the failure family this repo tracks (Codex P2). Refusing up
# front costs a second; refusing after a container boot and a 15 MB upload does not.
if ! command -v jq >/dev/null 2>&1; then
  echo "cross-engine-sweep: jq is required — the bundle-load check reads the transaction's per-entry statuses, and skipping it would let a partial load pass as a clean one." >&2
  exit 2
fi

BUNDLE="${BUNDLE_OVERRIDE:-${CONTENT}/bundles/measure/${NAME}/${NAME}-bundle.json}"
if [[ ! -f "$BUNDLE" ]]; then
  echo "cross-engine-sweep: no bundle at ${BUNDLE} (run scripts/fetch-official-cases.ps1)" >&2
  exit 2
fi

# EVERY progress line goes to stderr. stdout belongs to the check script, whose `--json` output the
# caller pipes or redirects — the workflow does `... | tee cross-engine-<measure>.json`, and a single
# "  sweeping" line on stdout makes that artifact unparseable for every consumer.
echo "cross-engine-sweep: ${MEASURE} (${NAME})" >&2
echo "  bundle    ${BUNDLE}$([[ -n "$BUNDLE_OVERRIDE" ]] && echo '  [MUTATED]')" >&2
echo "  container ${CONTAINER} on :${PORT} from ${IMAGE}" >&2

META=""
LOAD_LOG=""
cleanup() {
  rm -f "$META" "$LOAD_LOG" 2>/dev/null || true
  if [[ "$KEEP" -eq 0 ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  else
    echo "cross-engine-sweep: leaving ${CONTAINER} up (--keep). It is WARM — do not sweep against it again." >&2
  fi
}
trap cleanup EXIT

# 1. Always destroy first. A reused container is the silent-wrong-answer path.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER" -p "${PORT}:8080" \
  -e hapi.fhir.fhir_version=R4 \
  -e hapi.fhir.cr.enabled=true \
  -e hapi.fhir.allow_external_references=true \
  -e hapi.fhir.enforce_referential_integrity_on_write=false \
  "$IMAGE" >/dev/null

# 2. Ready means the CapabilityStatement NAMES the operation, not that /metadata answers.
echo -n "  waiting for evaluate-measure " >&2
READY=0
META="$(mktemp)"   # removed by the EXIT trap, so a Ctrl-C mid-poll leaks nothing
for _ in $(seq 1 120); do
  # Deliberately NOT `curl … | grep -q`: `grep -q` exits at the first match and closes the pipe, curl
  # dies of SIGPIPE, and under `pipefail` the pipeline reports failure — so the readiness probe would
  # never fire even against a server that has been ready for minutes. Fetch, then match.
  if curl -sf "${BASE}/metadata" -o "$META" 2>/dev/null && grep -q '"evaluate-measure"' "$META"; then READY=1; break; fi
  echo -n "." >&2
  sleep 5
done
echo >&2
rm -f "$META"
if [[ "$READY" -ne 1 ]]; then
  echo "cross-engine-sweep: ${BASE} never declared evaluate-measure (check hapi.fhir.cr.enabled)" >&2
  docker logs --tail 40 "$CONTAINER" >&2 || true
  exit 1
fi
sleep 30

echo "  loading bundle" >&2
# A per-run temp file rather than a fixed path: two sweeps of different measures can overlap on one
# machine (different container names, different ports), and a shared path would let one overwrite the
# other's diagnostics — which are the only thing that explains a failed load.
LOAD_LOG="$(mktemp)"   # per run, and removed by the EXIT trap
HTTP="$(curl -s -o "$LOAD_LOG" -w '%{http_code}' -X POST "$BASE" \
  -H 'Content-Type: application/fhir+json' --data-binary "@${BUNDLE}")"
if [[ "$HTTP" != "200" && "$HTTP" != "201" ]]; then
  echo "cross-engine-sweep: bundle load returned ${HTTP}" >&2
  head -c 2000 "$LOAD_LOG" >&2 || true
  exit 1
fi
# 200 is NOT "it loaded". A FHIR transaction answers 200 and reports each entry's own status inside the
# response bundle, so a load that failed for a Library or half the ValueSets still looks like success at
# the HTTP layer — and the sweep would then run against a server missing exactly the content the
# comparison is about, producing numbers rather than an error. Same class as the degenerate-sweep
# refusal: the failure is silent unless something looks (review finding).
# `|| echo 0` would turn a jq PARSE failure into "nothing wrong", which is the same silent pass the
# check exists to prevent, so a failure to parse is itself fatal (Codex P2).
if ! BAD="$(jq -r '[.entry[]?.response.status // "" | select(test("^[45]"))] | length' "$LOAD_LOG" 2>&1)"; then
  echo "cross-engine-sweep: could not parse the transaction response — refusing rather than assuming it loaded." >&2
  echo "  jq said: ${BAD}" >&2
  head -c 500 "$LOAD_LOG" >&2 || true
  exit 1
fi
if [[ "$BAD" != "0" ]]; then
  echo "cross-engine-sweep: the transaction returned ${HTTP} but ${BAD} entr(y/ies) failed inside it — the server is missing content the sweep needs." >&2
  jq -r '[.entry[]?.response.status // "" | select(test("^[45]"))] | unique | join(", ")' "$LOAD_LOG" >&2 || true
  exit 1
fi
sleep 20

echo "  sweeping" >&2
$PNPM exec tsx scripts/cross-engine-check.ts \
  --measure "$MEASURE" --server "$BASE" --load-terminology "${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"}"
