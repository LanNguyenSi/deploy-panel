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
# "Equal" and "differs" mean: compared with backend/prisma/baseline.prisma, the
# frozen schema of the baseline migration, never with the current schema.prisma.
# Because the repository holds only the baseline migration today, the scenarios
# that tell the two apart run the script from a scratch copy of the migrations
# folder with one extra migration (a nullable column on servers) and a
# schema.prisma extended by the same column; nothing of it is committed.
#
# plus the entrypoint's retry loop (database not ready, then ready; never
# ready; a definitive failure is not retried), its validation of
# MIGRATE_MAX_ATTEMPTS and MIGRATE_RETRY_DELAY, and every "could not check"
# branch of migrate.sh, driven through PRISMA_CLI with a stub that passes
# through to the real CLI except for one injected failure.
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
BASELINE_SCHEMA=backend/prisma/baseline.prisma
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
  # WORK_DIR is the exact directory mktemp printed below, holding only this run's files.
  [ -n "${WORK_DIR:-}" ] && [ -d "${WORK_DIR}" ] && rm -rf "${WORK_DIR}"
}
trap cleanup EXIT
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/backend-migrate-test.XXXXXX")" || exit 2
OUT_FILE="${WORK_DIR}/out"
: > "${OUT_FILE}"
STUB="${WORK_DIR}/prisma-stub.sh"
STUB_COUNT="${WORK_DIR}/stub-count"
cat > "${STUB}" <<'STUBEOF'
#!/bin/sh
# Test stub for PRISMA_CLI: passes every call through to the real CLI ($STUB_REAL)
# except the STUB_FAIL_NTH-th call (or every call when it is "all") whose first
# two arguments equal STUB_FAIL_KEY, e.g. "migrate diff" or "db execute": that
# call prints an error and exits 1.
if [ "$1 $2" = "${STUB_FAIL_KEY:-}" ]; then
  n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$STUB_COUNT"
  if [ "${STUB_FAIL_NTH}" = all ] || [ "$n" -eq "${STUB_FAIL_NTH}" ]; then
    echo "stub: injected failure on call $n of '$1 $2'" >&2
    exit 1
  fi
fi
exec "$STUB_REAL" "$@"
STUBEOF
chmod +x "${STUB}"
# stub_on <"command words"> <nth|all>: PRISMA_CLI becomes the stub until stub_off.
stub_on() {
  rm -f "${STUB_COUNT}"
  export PRISMA_CLI="${STUB}" STUB_REAL="${PRISMA}" STUB_COUNT STUB_FAIL_KEY="$1" STUB_FAIL_NTH="$2"
}
stub_off() { unset PRISMA_CLI STUB_REAL STUB_FAIL_KEY STUB_FAIL_NTH; }

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; [ -s "${OUT_FILE}" ] && sed 's/^/       | /' "${OUT_FILE}"; }

# run_migrate: runs migrate.sh against $URL from an unrelated directory (the
# script changes into the repository root itself); sets RC and OUT.
run_migrate() {
  (cd / && DATABASE_URL="${URL}" "${SH_BIN}" "${MIGRATE_SCRIPT:-${REPO_ROOT}/backend/scripts/migrate.sh}") >"${OUT_FILE}" 2>&1
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
finished_rows() { sql "${DB}" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL"; }
table_count() { sql "${DB}" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"; }
has_column() { test "$(sql "${DB}" "SELECT count(*) FROM information_schema.columns WHERE table_name = 'servers' AND column_name = '$1'")" = 1; }
has_history_table() { sql "${DB}" "SELECT to_regclass('public._prisma_migrations') IS NOT NULL"; }
# schema_matches [schema file [root]]: the database equals the schema file.
schema_matches() { (cd "${2:-${REPO_ROOT}}" && "${PRISMA}" migrate diff --from-url "${URL}" --to-schema-datamodel "${1:-${SCHEMA}}" --exit-code >/dev/null 2>&1); }

# legacy_db <suffix> [schema file]: a database as the releases before migrations
# left it: a schema applied by prisma db push (only these fixtures use db push),
# one server row, no migration history. The schema is the frozen baseline
# (baseline.prisma) unless a second argument names another file.
legacy_db() {
  new_db "$1"
  (cd "${REPO_ROOT}" && DATABASE_URL="${URL}" "${PRISMA}" db push --schema "${2:-${BASELINE_SCHEMA}}" --skip-generate) >"${OUT_FILE}" 2>&1 \
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
check "legacy differs: says the schema differs from the baseline schema" has_text "differs from the baseline schema ${BASELINE_SCHEMA}"
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

# --- the baseline is compared with the frozen baseline schema ---------------
# A scratch copy of the migrations folder with one extra migration (a nullable
# column on servers) and a schema.prisma extended by the same column. Today the
# repository holds only the baseline, where schema.prisma and baseline.prisma
# agree, so only this fixture tells apart a comparison with the baseline schema
# from one with the current schema.
FX_DIR="${WORK_DIR}/fx"
FX_SCRIPT="${FX_DIR}/backend/scripts/migrate.sh"
mkdir -p "${FX_DIR}/backend/scripts" "${FX_DIR}/backend/prisma/migrations/20261030000000_extra_note"
cp "${REPO_ROOT}/backend/scripts/migrate.sh" "${FX_SCRIPT}"
cp "${REPO_ROOT}/${BASELINE_SCHEMA}" "${FX_DIR}/${BASELINE_SCHEMA}"
cp -R "${REPO_ROOT}/backend/prisma/migrations/${BASELINE}" "${FX_DIR}/backend/prisma/migrations/"
cp "${REPO_ROOT}/backend/prisma/migrations/migration_lock.toml" "${FX_DIR}/backend/prisma/migrations/"
awk '{ print } /^  sshKeyPath +String\?$/ { print "  extraNote String?" }' "${REPO_ROOT}/${SCHEMA}" > "${FX_DIR}/${SCHEMA}"
echo 'ALTER TABLE "servers" ADD COLUMN "extraNote" TEXT;' > "${FX_DIR}/backend/prisma/migrations/20261030000000_extra_note/migration.sql"
ln -s "${REPO_ROOT}/node_modules" "${FX_DIR}/node_modules"
check "extra-migration fixture: its schema.prisma differs from baseline.prisma" test "$(grep -c extraNote "${FX_DIR}/${SCHEMA}")" = 1
MIGRATE_SCRIPT="${FX_SCRIPT}"

legacy_db fx_baseline
run_migrate
check "extra migration, database at the baseline: exit 0 (baselined, then the extra migration applied)" test "${RC}" -eq 0
check "extra migration, database at the baseline: baseline recorded as applied" has_text "recording the baseline migration ${BASELINE} as applied"
check "extra migration, database at the baseline: both migrations finished" test "$(finished_rows)" = 2
check "extra migration, database at the baseline: the extra column exists" has_column extraNote
check "extra migration, database at the baseline: data kept" test "$(sql "${DB}" "SELECT count(*) FROM servers")" = 1
check "extra migration, database at the baseline: now equals the extended schema.prisma" schema_matches "${SCHEMA}" "${FX_DIR}"

legacy_db fx_extended "${FX_DIR}/${SCHEMA}"
run_migrate
check "extra migration, no-history database equal to the extended schema: exit 1" test "${RC}" -eq 1
check "extra migration, extended no-history database: says it differs from the baseline schema" has_text "differs from the baseline schema ${BASELINE_SCHEMA}"
check "extra migration, extended no-history database: shows the extra column as the difference" has_text "extraNote"
check "extra migration, extended no-history database: no migration history created" test "$(has_history_table)" = f
check "extra migration, extended no-history database: row and column untouched" test "$(sql "${DB}" "SELECT count(*) FROM servers")$(has_column extraNote && echo c)" = 1c

new_db fx_fresh
run_migrate
check "extra migration, fresh database: exit 0" test "${RC}" -eq 0
check "extra migration, fresh database: both migrations finished" test "$(finished_rows)" = 2
check "extra migration, fresh database: equals the extended schema.prisma" schema_matches "${SCHEMA}" "${FX_DIR}"

# A deployed database that has only the baseline in its history picks up the new migration.
new_db fx_upgrade
MIGRATE_SCRIPT=
run_migrate
check "upgrade: the baseline alone is applied by the repository's own migrations" test "$(finished_rows)" = 1
MIGRATE_SCRIPT="${FX_SCRIPT}"
run_migrate
check "upgrade: exit 0" test "${RC}" -eq 0
check "upgrade: takes the migration-history path" has_text "migration history found"
check "upgrade: the extra migration is applied" test "$(finished_rows)$(has_column extraNote && echo c)" = 2c

legacy_db fx_nobaselinefile
mv "${FX_DIR}/${BASELINE_SCHEMA}" "${FX_DIR}/${BASELINE_SCHEMA}.off"
run_migrate
mv "${FX_DIR}/${BASELINE_SCHEMA}.off" "${FX_DIR}/${BASELINE_SCHEMA}"
check "baseline.prisma missing: exit 1" test "${RC}" -eq 1
check "baseline.prisma missing: says which file is missing" has_text "${BASELINE_SCHEMA} is missing"
check "baseline.prisma missing: database untouched" test "$(has_history_table)$(sql "${DB}" "SELECT count(*) FROM servers")" = f1
MIGRATE_SCRIPT=

# --- the baseline schema file matches the baseline migration ----------------
(cd "${REPO_ROOT}" && "${PRISMA}" migrate diff --from-empty --to-schema-datamodel "${BASELINE_SCHEMA}" --script) > "${WORK_DIR}/baseline-from-schema.sql" 2>"${OUT_FILE}"
if cmp -s "${WORK_DIR}/baseline-from-schema.sql" "${REPO_ROOT}/backend/prisma/migrations/${BASELINE}/migration.sql"; then
  ok "baseline.prisma produces ${BASELINE}/migration.sql byte for byte"
else
  bad "baseline.prisma no longer produces ${BASELINE}/migration.sql byte for byte (the frozen file drifted)"
fi

# --- history table without a finished migration ------------------------------
# What `prisma migrate` creates, so a stale or empty table looks real.
HISTORY_DDL='CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY NOT NULL, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)'
legacy_db stale_history
sql "${DB}" "${HISTORY_DDL}" >/dev/null
run_migrate
check "stale empty history table next to tables: exit 1" test "${RC}" -eq 1
check "stale empty history table: says no migration is finished" has_text "no migration is finished"
check "stale empty history table: the baseline SQL is not run (no failed row)" test "$(sql "${DB}" "SELECT count(*) FROM _prisma_migrations")" = 0
check "stale empty history table: application data untouched" test "$(sql "${DB}" "SELECT count(*) FROM servers")" = 1
check "stale empty history table: names the recovery and forbids db push" has_text "Do not run prisma db push"

legacy_db failed_history
sql "${DB}" "${HISTORY_DDL}" >/dev/null
sql "${DB}" "INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ('x', 'y', '${BASELINE}')" >/dev/null
run_migrate
check "history with only a failed row next to tables: exit 1" test "${RC}" -eq 1
check "history with only a failed row: refused before prisma migrate deploy" lacks_text "P3009"
check "history with only a failed row: the failed row is the only row" test "$(sql "${DB}" "SELECT count(*) FROM _prisma_migrations")" = 1

new_db empty_history
sql "${DB}" "${HISTORY_DDL}" >/dev/null
run_migrate
check "empty history table in an empty database: exit 0" test "${RC}" -eq 0
check "empty history table in an empty database: takes the deploy path" has_text "database has no tables; applying pending migrations"
check "empty history table in an empty database: baseline applied" test "$(history_rows)" = 1

legacy_db unreadable_history
sql "${DB}" "${HISTORY_DDL}" >/dev/null
stub_on "db execute" 3
run_migrate
stub_off
check "history unreadable (third probe fails): exit 3" test "${RC}" -eq 3
check "history unreadable: says so" has_text "could not read the migration history"
check "history unreadable: nothing changed" test "$(sql "${DB}" "SELECT count(*) FROM _prisma_migrations")$(sql "${DB}" "SELECT count(*) FROM servers")" = 01

# --- "could not check" branches: exit 3, nothing changed, entrypoint retries --
# One injected CLI failure per call position. Each time the database is left
# exactly as it was, migrate.sh answers 3, and the entrypoint's second attempt
# (the stub fails only once) completes the migration.
check_could_not_check() { # <name> <db state label> <command words> <nth> <expected text> <expected final history rows>
  stub_on "$3" "$4"
  run_migrate
  stub_off
  check "$1: exit 3" test "${RC}" -eq 3
  check "$1: says what it could not check" has_text "$5"
  check "$1: no migration history created" test "$(has_history_table)" = f
  if [ "$2" = fresh ]; then
    check "$1: no tables created" test "$(table_count)" = 0
  else
    check "$1: rows untouched" test "$(sql "${DB}" "SELECT count(*) FROM servers")" = 1
  fi
  stub_on "$3" "$4"
  ATTEMPTS=3 DELAY=1 run_entrypoint sh -c 'echo SERVER-STARTED'
  stub_off
  check "$1: entrypoint retries the exit 3" has_text "migration check attempt 1 failed, retrying in 1s"
  check "$1: entrypoint exit 0 after the retry" test "${RC}" -eq 0
  check "$1: server started after the retry" has_text "SERVER-STARTED"
  check "$1: migrations finished after the retry" test "$(history_rows)" = 1
}
new_db cnc_history
check_could_not_check "second history probe fails" fresh "db execute" 2 "could not tell whether the database has a migration history"
new_db cnc_empty
check_could_not_check "empty-database check fails" fresh "migrate diff" 1 "could not tell whether the database is empty"
legacy_db cnc_compare
check_could_not_check "baseline comparison fails" legacy "migrate diff" 2 "could not compare the database with ${BASELINE_SCHEMA}"

# --- entrypoint: MIGRATE_MAX_ATTEMPTS and MIGRATE_RETRY_DELAY ----------------
# The stub fails every history probe, so migrate.sh answers 3 at once and the
# loop length is what is measured. An unset or empty variable means the
# default (10 attempts, 2 seconds); the other variable keeps its own default.
new_db entry_values
env_entry() { # env_entry <MAX or ""> <DELAY or ""> : run the entrypoint with these values (unset when empty)
  stub_on "db execute" all
  (cd "${REPO_ROOT}" && unset MIGRATE_MAX_ATTEMPTS MIGRATE_RETRY_DELAY \
    && { [ -z "$1" ] || export MIGRATE_MAX_ATTEMPTS="$1"; } && { [ -z "$2" ] || export MIGRATE_RETRY_DELAY="$2"; } \
    && DATABASE_URL="${URL}" "${SH_BIN}" backend/backend-entrypoint.sh sh -c 'echo SERVER-STARTED') >"${OUT_FILE}" 2>&1
  RC=$?
  OUT="$(cat "${OUT_FILE}")"
  stub_off
}
env_entry 4 0
check "attempts 4, delay 0: gives up after 4 attempts" has_text "could not be checked after 4 attempts"
check "attempts 4, delay 0: waits 0s between attempts" has_text "retrying in 0s"
check "attempts 4, delay 0: server not started" lacks_text "SERVER-STARTED"
env_entry "" 0
check "attempts unset, delay 0: the default is 10 attempts" has_text "could not be checked after 10 attempts"
env_entry 08 0
check "attempts 08 is read as decimal 8, not octal" has_text "could not be checked after 8 attempts"
env_entry 2 ""
check "attempts 2, delay unset: the default delay is 2s" has_text "retrying in 2s"
env_entry 1 0
check "attempts 1: no retry, gives up at once" lacks_text "retrying in"
for bad_max in 0 abc -1 1.5 " 3" 1234567; do
  env_entry "${bad_max}" 0
  check "attempts '${bad_max}': exits 1 without migrating" test "${RC}" -eq 1
  check "attempts '${bad_max}': names the variable" has_text "MIGRATE_MAX_ATTEMPTS must be a whole number of at least 1"
  check "attempts '${bad_max}': neither migrates nor starts the server" test "$(has_text "Applying database migrations" && echo m)$(has_text SERVER-STARTED && echo s)" = ""
done
for bad_delay in abc -1 2.5 1234567; do
  env_entry 2 "${bad_delay}"
  check "delay '${bad_delay}': exits 1 without migrating" test "${RC}" -eq 1
  check "delay '${bad_delay}': names the variable" has_text "MIGRATE_RETRY_DELAY must be a whole number of at least 0"
  check "delay '${bad_delay}': neither migrates nor starts the server" test "$(has_text "Applying database migrations" && echo m)$(has_text SERVER-STARTED && echo s)" = ""
done

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
