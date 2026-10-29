#!/usr/bin/env bash
# Tests for backend/scripts/migrate.sh and backend/backend-entrypoint.sh against
# a real Postgres and the real Prisma CLI installed in node_modules (npm ci at
# the repository root). Every scenario creates its own database, so the
# decision of the start-time migration step is checked on the four states a
# production database can be in:
#
#   fresh (empty) database          -> all migrations applied
#   already migrated                -> idempotent re-run
#   from before migrations, equal   -> baseline recorded as applied, data kept
#   from before migrations, differs -> refused, database untouched
#
# plus the entrypoint's retry loop (database not ready, then ready; never
# ready; a definitive failure is not retried).
#
# Needs a Postgres 13+ server and psql, or Docker with a container to exec into.
#   MIGRATE_TEST_PG         server URL without a database name
#                           (default postgresql://postgres:postgres@127.0.0.1:5432),
#                           the CI service container
#   MIGRATE_TEST_PG_CONTAINER  when psql is not installed: name of a running
#                           Postgres container; SQL then runs through
#                           `docker exec <name> psql -U postgres`
#   MIGRATE_TEST_SH         shell that runs the scripts (default sh); the image
#                           runs busybox ash, CI's sh is dash
#
# Usage: bash scripts/backend-migrate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BASELINE=20261029120000_baseline
PG="${MIGRATE_TEST_PG:-postgresql://postgres:postgres@127.0.0.1:5432}"
PG="${PG%/}"
PG_CONTAINER="${MIGRATE_TEST_PG_CONTAINER:-}"
SH_BIN="${MIGRATE_TEST_SH:-sh}"
RUN_ID="mt$$"
SCHEMA=backend/prisma/schema.prisma
PRISMA="${REPO_ROOT}/node_modules/.bin/prisma"

if [ ! -x "${PRISMA}" ]; then
  echo "node_modules/.bin/prisma not found: run npm ci at the repository root first" >&2
  exit 2
fi

# sql <database> <statement>: runs one statement, prints the unaligned result.
sql() {
  if [ -n "${PG_CONTAINER}" ]; then
    docker exec -i "${PG_CONTAINER}" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -At -c "$2"
  else
    psql "${PG}/$1" -v ON_ERROR_STOP=1 -At -c "$2"
  fi
}

DBS=()
new_db() { # new_db <suffix>: creates the database, sets DB and URL
  DB="${RUN_ID}_$1"
  sql postgres "CREATE DATABASE ${DB}" >/dev/null || { echo "cannot create database ${DB} (is Postgres reachable at ${PG}?)" >&2; exit 2; }
  DBS+=("${DB}")
  URL="${PG}/${DB}"
}
cleanup() {
  local d
  for d in "${DBS[@]:-}"; do
    [ -n "${d}" ] && sql postgres "DROP DATABASE IF EXISTS ${d} WITH (FORCE)" >/dev/null 2>&1
  done
  [ -n "${LATE_PID:-}" ] && kill "${LATE_PID}" 2>/dev/null
  rm -f "${OUT_FILE:-}"
}
trap cleanup EXIT
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/backend-migrate-test.XXXXXX")"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; [ -s "${OUT_FILE}" ] && sed 's/^/       | /' "${OUT_FILE}"; }

# run_migrate: runs migrate.sh against $URL from an unrelated directory (the
# script changes into the repository root itself); sets RC and OUT.
run_migrate() {
  (cd / && DATABASE_URL="${URL}" "${SH_BIN}" "${REPO_ROOT}/backend/scripts/migrate.sh") >"${OUT_FILE}" 2>&1
  RC=$?
  OUT="$(cat "${OUT_FILE}")"
}
# run_entrypoint <args...>: runs the entrypoint from the repository root
# (the image's WORKDIR) with a short retry loop; sets RC and OUT.
run_entrypoint() {
  (cd "${REPO_ROOT}" && DATABASE_URL="${URL}" MIGRATE_MAX_ATTEMPTS="${ATTEMPTS:-3}" MIGRATE_RETRY_DELAY="${DELAY:-1}" \
    "${SH_BIN}" backend/backend-entrypoint.sh "$@") >"${OUT_FILE}" 2>&1
  RC=$?
  OUT="$(cat "${OUT_FILE}")"
}
# check <name> <condition...>: ok when the condition command succeeds.
check() { local name="$1"; shift; if "$@"; then ok "${name}"; else bad "${name}"; fi; }
has_text() { case "${OUT}" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
lacks_text() { ! has_text "$1"; }
history_rows() { sql "${DB}" "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '${BASELINE}' AND finished_at IS NOT NULL"; }
has_history_table() { sql "${DB}" "SELECT to_regclass('public._prisma_migrations') IS NOT NULL"; }
schema_matches() { (cd "${REPO_ROOT}" && "${PRISMA}" migrate diff --from-url "${URL}" --to-schema-datamodel "${SCHEMA}" --exit-code >/dev/null 2>&1); }

# legacy_db <suffix>: a database as the releases before migrations left it:
# the schema applied by prisma db push (only this fixture uses db push), one
# server row, no migration history.
legacy_db() {
  new_db "$1"
  (cd "${REPO_ROOT}" && DATABASE_URL="${URL}" "${PRISMA}" db push --schema "${SCHEMA}" --skip-generate) >"${OUT_FILE}" 2>&1 \
    || { echo "fixture: prisma db push failed" >&2; cat "${OUT_FILE}" >&2; exit 2; }
  sql "${DB}" "INSERT INTO servers (id, name, host, status, \"updatedAt\") VALUES ('s1', 'prod', 'prod.example.test', 'unknown', now())" >/dev/null
}

# --- fresh database ----------------------------------------------------------
new_db fresh
run_migrate
check "fresh database: exit 0" test "${RC}" -eq 0
check "fresh database: takes the empty-database path" has_text "empty database, applying all migrations"
check "fresh database: baseline recorded and finished in _prisma_migrations" test "$(history_rows)" = 1
check "fresh database: tables match schema.prisma exactly" schema_matches
check "fresh database: servers table exists" test "$(sql "${DB}" "SELECT count(*) FROM servers")" = 0

# --- migrated database: idempotent -------------------------------------------
run_migrate
check "migrated database: exit 0" test "${RC}" -eq 0
check "migrated database: detects the migration history" has_text "migration history found"
check "migrated database: does not record the baseline again" test "$(history_rows)" = 1
check "migrated database: still matches schema.prisma" schema_matches

# --- from before migrations, equal to the baseline ---------------------------
legacy_db legacy
check "legacy fixture: tables exist and no migration history yet" test "$(has_history_table)" = f
run_migrate
check "legacy equal: exit 0" test "${RC}" -eq 0
check "legacy equal: baseline recorded as applied" has_text "recording the baseline migration ${BASELINE} as applied"
check "legacy equal: one finished baseline row" test "$(history_rows)" = 1
check "legacy equal: the existing row survived (baseline was not run)" test "$(sql "${DB}" "SELECT count(*) FROM servers")" = 1
run_migrate
check "legacy equal: second run is the idempotent path" has_text "migration history found"
check "legacy equal: second run keeps one baseline row" test "$(history_rows)" = 1

# --- from before migrations, differs from the schema -------------------------
legacy_db drifted
sql "${DB}" "ALTER TABLE servers ADD COLUMN legacy_note text" >/dev/null
sql "${DB}" "UPDATE servers SET legacy_note = 'keep me'" >/dev/null
run_migrate
check "legacy differs: exit 1" test "${RC}" -eq 1
check "legacy differs: says the schema differs" has_text "differs from ${SCHEMA}"
check "legacy differs: shows the difference" has_text "legacy_note"
check "legacy differs: names the recovery and forbids db push" has_text "Do not run prisma db push"
check "legacy differs: no migration history created" test "$(has_history_table)" = f
check "legacy differs: rows untouched (count)" test "$(sql "${DB}" "SELECT count(*) FROM servers")" = 1
check "legacy differs: extra column and its data untouched" test "$(sql "${DB}" "SELECT legacy_note FROM servers")" = "keep me"

# --- database not reachable: retry, then fail --------------------------------
# A database that does not exist yet answers every check with an error (P1003),
# the same outcome as a server that is not accepting connections.
DB="${RUN_ID}_late"
URL="${PG}/${DB}"
DBS+=("${DB}")
run_migrate
check "database missing: migrate.sh exit 3 (could not check, nothing changed)" test "${RC}" -eq 3
check "database missing: says it could not tell" has_text "could not tell whether the database has a migration history"

ATTEMPTS=3 DELAY=1 run_entrypoint sh -c 'echo SERVER-STARTED'
check "never ready: entrypoint exits non-zero" test "${RC}" -ne 0
check "never ready: first attempt is retried" has_text "migration check attempt 1 failed, retrying in 1s"
check "never ready: second attempt is retried" has_text "migration check attempt 2 failed, retrying in 1s"
check "never ready: gives up after the last attempt" has_text "could not be checked after 3 attempts"
check "never ready: the server is not started" lacks_text "SERVER-STARTED"

# The database appears while the entrypoint is retrying.
(sleep 2; sql postgres "CREATE DATABASE ${DB}" >/dev/null 2>&1) &
LATE_PID=$!
ATTEMPTS=15 DELAY=1 run_entrypoint sh -c 'echo SERVER-STARTED'
wait "${LATE_PID}" 2>/dev/null
LATE_PID=
check "ready after retries: entrypoint exit 0" test "${RC}" -eq 0
check "ready after retries: at least one retry was logged" has_text "retrying in 1s"
check "ready after retries: migrations applied" has_text "Schema at the committed migrations"
check "ready after retries: baseline recorded" test "$(history_rows)" = 1
check "ready after retries: the server command runs last" has_text "SERVER-STARTED"

# --- the entrypoint on the other outcomes ------------------------------------
new_db entry_fresh
run_entrypoint sh -c 'echo SERVER-STARTED'
check "entrypoint, fresh database: starts the server, no retry needed" test "${RC}" -eq 0
check "entrypoint, fresh database: no retry logged" lacks_text "retrying in"
check "entrypoint, fresh database: server started" has_text "SERVER-STARTED"

legacy_db entry_drifted
sql "${DB}" "ALTER TABLE servers DROP COLUMN \"relayDir\"" >/dev/null
ATTEMPTS=5 DELAY=1 run_entrypoint sh -c 'echo SERVER-STARTED'
check "entrypoint, differing legacy database: exits non-zero" test "${RC}" -ne 0
check "entrypoint, differing legacy database: a definitive failure is not retried" lacks_text "retrying in"
check "entrypoint, differing legacy database: says so" has_text "Not retrying"
check "entrypoint, differing legacy database: server not started" lacks_text "SERVER-STARTED"
check "entrypoint, differing legacy database: untouched" test "$(has_history_table)" = f

# --- contracts with the repository -------------------------------------------
script_baseline="$(sed -n 's/^BASELINE_MIGRATION=//p' "${REPO_ROOT}/backend/scripts/migrate.sh")"
first_migration="$(find "${REPO_ROOT}/backend/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort | head -n 1)"
if [ "${script_baseline}" = "${BASELINE}" ] && [ "${first_migration}" = "${BASELINE}" ] && [ -s "${REPO_ROOT}/backend/prisma/migrations/${BASELINE}/migration.sql" ]; then
  ok "BASELINE_MIGRATION names the first committed migration, which has a migration.sql"
else
  : > "${OUT_FILE}"
  bad "BASELINE_MIGRATION is '${script_baseline}', the first migration directory is '${first_migration}', this test expects '${BASELINE}' with a migration.sql"
fi
if grep -qx 'provider = "postgresql"' "${REPO_ROOT}/backend/prisma/migrations/migration_lock.toml" 2>/dev/null; then
  ok "migration_lock.toml pins the postgresql provider"
else
  : > "${OUT_FILE}"
  bad "backend/prisma/migrations/migration_lock.toml is missing or not postgresql"
fi
if grep -q '^COPY backend/scripts/migrate.sh backend/scripts/migrate.sh$' "${REPO_ROOT}/backend/Dockerfile"; then
  ok "the runtime image copies migrate.sh (the entrypoint runs it)"
else
  : > "${OUT_FILE}"
  bad "backend/Dockerfile does not COPY backend/scripts/migrate.sh"
fi
if node -e '
  const p = require(process.argv[1]);
  process.exit(p.dependencies && p.dependencies.prisma && !(p.devDependencies && p.devDependencies.prisma) ? 0 : 1);
' "${REPO_ROOT}/backend/package.json"; then
  ok "prisma is a runtime dependency (the runtime image installs with --omit=dev)"
else
  : > "${OUT_FILE}"
  bad "backend/package.json: prisma must be in dependencies, not devDependencies"
fi

echo
echo "shell: ${SH_BIN}"
echo "passed=${PASS} failed=${FAIL}"
[ "${FAIL}" -eq 0 ]
