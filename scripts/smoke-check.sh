#!/bin/sh
#
# smoke-check.sh — post-deploy sanity check for deploy-panel.
#
# Hits the critical endpoints and fails loudly if anything is wrong.
# Designed to run as the last step of a deploy (from the operator's
# laptop or from a CI job) and to catch the class of regressions that
# the existing `/api/health` endpoint can't see.
#
#   Usage:
#     DEPLOY_PANEL_URL=https://deploy-panel.example.com \
#     PANEL_TOKEN=... \
#     ./scripts/smoke-check.sh
#
#   Exit codes:
#     0 — all hard checks passed (offline servers produce a warning only)
#     1 — a hard check failed; stderr has the remediation hint
#     2 — PANEL_TOKEN missing
#
# Why this is not redundant with `/api/health`:
#   `/api/health` returns 200 as long as the Hono process is up. It
#   does NOT exercise the Prisma client, which means a schema drift
#   (the exact cause of the 2026-04-12 outage) will pass `/health`
#   but crash every real query. This script pushes actual DB-backed
#   requests through the Prisma client, so drift surfaces immediately.
#
# POSIX sh only. Dependencies: curl, jq.

set -u

DEPLOY_PANEL_URL="${DEPLOY_PANEL_URL:-http://localhost:3001}"
# Strip trailing slash so we can interpolate safely.
DEPLOY_PANEL_URL="${DEPLOY_PANEL_URL%/}"

if [ -z "${PANEL_TOKEN:-}" ]; then
  echo "FAIL — PANEL_TOKEN is not set" >&2
  echo "       export PANEL_TOKEN=... and retry" >&2
  exit 2
fi

# Verify our deps are present before making any request.
for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "FAIL — missing dependency: $cmd" >&2
    exit 1
  fi
done

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1" >&2
  [ -n "${2:-}" ] && printf '      %s\n' "$2" >&2
  [ -n "${3:-}" ] && printf '      hint: %s\n' "$3" >&2
  exit 1
}
warn() { printf 'WARN  %s\n' "$1"; }

# ── Shared curl wrapper ────────────────────────────────────────────────
# Writes the HTTP status code to stdout and the body to a tempfile.
# Callers pass the tempfile path + the expected status.
BODY_TMP="$(mktemp)"
cleanup() { rm -f "$BODY_TMP"; }
trap cleanup EXIT INT TERM

http() {
  # http <METHOD> <PATH>
  # Returns the HTTP status code on stdout, body in $BODY_TMP.
  # `%{http_code}` always writes something (000 on connection failure)
  # so no `|| fallback` is needed — and adding one would append to the
  # already-printed "000", yielding a garbled "000000".
  curl -sS \
    -o "$BODY_TMP" \
    -w '%{http_code}' \
    --max-time 10 \
    -X "$1" \
    -H "Authorization: Bearer $PANEL_TOKEN" \
    "${DEPLOY_PANEL_URL}$2"
}

assert_status() {
  # assert_status <name> <actual> <expected>
  if [ "$2" != "$3" ]; then
    fail "$1" "expected HTTP $3, got HTTP $2 (body: $(cut -c1-200 "$BODY_TMP" | head -n 1))"
  fi
}

assert_json_has() {
  # assert_json_has <name> <jq filter that must return non-null/non-empty>
  if ! jq -e "$2" "$BODY_TMP" >/dev/null 2>&1; then
    fail "$1" "JSON shape unexpected: $(cut -c1-200 "$BODY_TMP" | head -n 1)"
  fi
}

echo "Smoke-checking $DEPLOY_PANEL_URL"
echo

# ── 1. liveness ────────────────────────────────────────────────────────
# /api/health is unauthenticated; the token header is harmless.
code="$(http GET /api/health)"
assert_status "liveness (/api/health)" "$code" "200"
assert_json_has "liveness body shape" '.status'
pass "liveness — /api/health reachable"

# ── 2. auth reachable + server list + DB up ───────────────────────────
# Exercises requireAuth middleware + prisma.server.findMany.
code="$(http GET /api/v1/servers)"
if [ "$code" = "401" ] || [ "$code" = "403" ]; then
  fail "auth reachable" \
    "HTTP $code on /api/v1/servers — PANEL_TOKEN rejected" \
    "verify PANEL_TOKEN matches the backend .env"
fi
assert_status "auth reachable (/api/v1/servers)" "$code" "200"
assert_json_has "server list shape" '.servers | type == "array"'
SERVER_COUNT="$(jq -r '.servers | length' "$BODY_TMP")"
pass "auth reachable — $SERVER_COUNT server(s) returned"

# Stash the server ids + names for the reachability checks below. We
# read them here into two space-separated shell vars because POSIX sh
# has no arrays — jq gives us newline-joined pairs and we loop with
# read.
SERVERS_JSON="$(cat "$BODY_TMP")"

# ── 3. apps query — the one that would have caught 2026-04-12 ─────────
# Exercises prisma.app.findMany, which is the exact call path that
# crashed when App.liveUrl was missing from the DB.
code="$(http GET /api/v1/apps)"
if [ "$code" = "500" ]; then
  fail "apps query" \
    "HTTP 500 on /api/v1/apps — likely Prisma schema drift" \
    "run: docker compose exec backend npx prisma db push --schema=backend/prisma/schema.prisma --skip-generate"
fi
assert_status "apps query (/api/v1/apps)" "$code" "200"
assert_json_has "apps list shape" '.apps | type == "array"'
APP_COUNT="$(jq -r '.apps | length' "$BODY_TMP")"
pass "apps query — $APP_COUNT app(s) returned"

# ── 4. scheduled query ────────────────────────────────────────────────
# Exercises the scheduled_deploys table. Another place schema drift
# would hide.
code="$(http GET '/api/scheduled?status=pending')"
assert_status "scheduled query (/api/scheduled?status=pending)" "$code" "200"
assert_json_has "scheduled list shape" '.scheduled | type == "array"'
PENDING_COUNT="$(jq -r '.scheduled | length' "$BODY_TMP")"
pass "scheduled query — $PENDING_COUNT pending"

# ── 5. per-server reachability ────────────────────────────────────────
# Soft check: iterate the servers returned by (2), POST /test for each,
# print the result. An offline server is a WARN, not a hard fail —
# the operator may have a legitimate reason for one being down.
echo
echo "Server reachability:"
echo "$SERVERS_JSON" | jq -r '.servers[] | "\(.id) \(.name)"' | while IFS=' ' read -r srv_id srv_name; do
  [ -z "$srv_id" ] && continue
  code="$(http POST "/api/servers/$srv_id/test")"
  if [ "$code" != "200" ]; then
    warn "  $srv_name — test endpoint HTTP $code"
    continue
  fi
  status="$(jq -r '.status' "$BODY_TMP")"
  msg="$(jq -r '.message // ""' "$BODY_TMP")"
  case "$status" in
    online)
      pass "  $srv_name — online"
      ;;
    offline|no-relay)
      if [ -n "$msg" ] && [ "$msg" != "null" ]; then
        warn "  $srv_name — $status ($msg)"
      else
        warn "  $srv_name — $status"
      fi
      ;;
    *)
      warn "  $srv_name — unknown status: $status"
      ;;
  esac
done

echo
echo "All hard checks passed."
exit 0
