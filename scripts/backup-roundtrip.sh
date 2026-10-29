#!/usr/bin/env bash
# Round-trip check against a real Postgres: proves that scripts/backup.sh and
# scripts/restore.sh really back up and restore a database. The stub tests
# (backup.test.sh, restore.test.sh) pin the scripts' logic against a fake docker; this
# runs the REAL scripts against a real server, so a drift in a pg_dump, pg_restore or
# psql option fails here. Runs in CI against a throwaway Postgres 16 and can be run by
# hand against any scratch Postgres container; never point it at production.
#
# It creates two fresh databases in the container (drill_src, drill_dst; an existing
# database of that name is dropped), builds the schema of backend/prisma/schema.prisma in
# drill_src with `prisma migrate diff --from-empty --to-schema-datamodel --script` (so it
# works before and after the schema is managed by migrations), seeds a few rows, runs the
# REAL scripts/backup.sh, restores the dump with the REAL scripts/restore.sh into
# drill_dst, and asserts row counts, one row's content and a unique constraint. Then it
# restores the same dump into the now populated drill_dst after a table a newer release
# would add (with a foreign key into a dumped table) and a row written after the dump were
# created: both must be gone afterwards and the pre-restore dump must hold them. Finally a
# truncated dump and a SQL copy that vanishes after conversion must leave the database
# unchanged, and a pg_dump cut short must not be published. The scripts see a `docker`
# shim that maps `docker compose -f <file> exec -T db <cmd>` onto
# `docker exec -i <container> <cmd>`, so every pg_dump, pg_restore and psql option comes
# from the scripts themselves.
#
# Usage:
#   DRILL_PG_CONTAINER=<container of a postgres:16 started with user deploy_panel> \
#   scripts/backup-roundtrip.sh
# Run it from anywhere; it uses the checkout it lives in (needs `npm ci` done, for prisma).
# Exit 0: every check passed. Exit 1: a check failed or a step could not run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DRILL_PG_CONTAINER:?set DRILL_PG_CONTAINER to the scratch Postgres container}"
SRC_DB=drill_src
DST_DB=drill_dst
PG_ROLE=deploy_panel
EXPECT_USERS=2
EXPECT_KEYS=3
EXPECT_KEY_ROW='restored-key|dp_drill3|sha256:drill-three|drill-u2'

REAL_DOCKER="$(command -v docker)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/backups" "$WORK/tmp"
: > "$WORK/compose.yml"

# The shim answers only the compose calls the scripts make.
cat > "$WORK/bin/docker" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = compose ] && [ "\$2" = -f ]; then
  shift 3
  case "\$1" in
    ps) echo db; exit 0 ;;
    exec)
      shift
      [ "\$1" = -T ] && shift
      shift # service name
      # DRILL_RM_ON_DUMP: files (glob allowed) removed when a pg_dump runs, i.e. between
      # restore.sh converting the dump and loading it
      case "\$*" in
        *pg_dump*) [ -z "\${DRILL_RM_ON_DUMP:-}" ] || rm -f \$DRILL_RM_ON_DUMP ;;
      esac
      exec "$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" "\$@"
      ;;
  esac
fi
echo "roundtrip docker shim: unexpected call: \$*" >&2
exit 9
SHIM
chmod +x "$WORK/bin/docker"

sql() { # sql <database> <statement>: print the bare result
  "$REAL_DOCKER" exec -i -e PGOPTIONS='-c client_min_messages=warning' "$DRILL_PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$PG_ROLE" -d "$1" -tA -c "$2"
}
fail() { echo "roundtrip: FAIL: $*" >&2; exit 1; }
expect() { # expect <label> <actual> <expected>
  [ "$2" = "$3" ] || fail "$1: got '$2', expected '$3'"
  echo "roundtrip: ok: $1 = $3"
}
# run_script <script> <env assignments...> -- <args...>: run a REAL script against the shim
run_script() {
  local script="$1"; shift
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  env PATH="$WORK/bin:$PATH" BACKUP_COMPOSE_FILE="$WORK/compose.yml" BACKUP_DIR="$WORK/backups" \
    TMPDIR="$WORK/tmp" PG_USER="$PG_ROLE" "${envs[@]}" "$REPO_ROOT/scripts/$script" "$@"
}

# The script drops and creates databases: refuse the production container by name.
guard_container() { # guard_container <container name>
  [ "$1" != deploy-panel-db ] || fail "refusing to run against the production container deploy-panel-db"
}
guard_container "$DRILL_PG_CONTAINER"

echo "roundtrip: creating the schema of backend/prisma/schema.prisma in fresh databases"
(cd "$REPO_ROOT/backend" && HOME="$WORK" npx prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/schema.prisma --script) > "$WORK/schema.sql"
[ -s "$WORK/schema.sql" ] || fail "prisma produced an empty schema script"
for db in "$SRC_DB" "$DST_DB"; do
  sql postgres "DROP DATABASE IF EXISTS $db" > /dev/null
  sql postgres "CREATE DATABASE $db OWNER $PG_ROLE" > /dev/null
done
"$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$PG_ROLE" -d "$SRC_DB" < "$WORK/schema.sql" > /dev/null

echo "roundtrip: seeding"
sql "$SRC_DB" "INSERT INTO users (id, \"githubId\", \"githubLogin\", \"updatedAt\") VALUES
  ('drill-u1', 'gh-1', 'drill-one', now()),
  ('drill-u2', 'gh-2', 'drill-two', now())" > /dev/null
sql "$SRC_DB" "INSERT INTO sessions (id, \"tokenHash\", \"userId\", \"expiresAt\") VALUES
  ('drill-s1', 'hash-one', 'drill-u1', now() + interval '1 day')" > /dev/null
sql "$SRC_DB" "INSERT INTO api_keys (id, name, \"keyHash\", \"keyPrefix\", \"userId\") VALUES
  ('drill-k1', 'key-one', 'sha256:drill-one', 'dp_drill1', 'drill-u1'),
  ('drill-k2', 'key-two', 'sha256:drill-two', 'dp_drill2', 'drill-u1'),
  ('drill-k3', 'restored-key', 'sha256:drill-three', 'dp_drill3', 'drill-u2')" > /dev/null
expect "seeded users" "$(sql "$SRC_DB" 'SELECT count(*) FROM users')" "$EXPECT_USERS"

echo "roundtrip: backup.sh"
run_script backup.sh PG_DB="$SRC_DB" --
dump="$(find "$WORK/backups" -maxdepth 1 -name 'deploy-panel-*.dump')"
if [ -z "$dump" ] || [ "$(wc -l <<< "$dump" | tr -d ' ')" != 1 ]; then
  fail "expected exactly one dump in $WORK/backups"
fi

echo "roundtrip: restore.sh into a fresh database"
# A fresh database is below backup.sh's size floor, so no pre-restore dump here; the shim
# has no `stop` or `start`, so the backend step is skipped.
run_script restore.sh RESTORE_APP_SERVICE='' PG_DB="$DST_DB" -- --yes --no-pre-backup "$dump"

echo "roundtrip: asserting the restored database"
expect "restored users" "$(sql "$DST_DB" 'SELECT count(*) FROM users')" "$EXPECT_USERS"
expect "restored api keys" "$(sql "$DST_DB" 'SELECT count(*) FROM api_keys')" "$EXPECT_KEYS"
expect "restored sessions" "$(sql "$DST_DB" 'SELECT count(*) FROM sessions')" 1
expect "restored row content" \
  "$(sql "$DST_DB" "SELECT name || '|' || \"keyPrefix\" || '|' || \"keyHash\" || '|' || \"userId\" FROM api_keys WHERE id = 'drill-k3'")" \
  "$EXPECT_KEY_ROW"
expect "unique constraint on api key hashes" \
  "$(sql "$DST_DB" "SELECT count(*) FROM pg_indexes WHERE tablename = 'api_keys' AND indexdef LIKE '%UNIQUE%keyHash%'")" 1

echo "roundtrip: restore into a populated database whose schema is newer than the dump"
cp "$dump" "$WORK/first.dump"
sql "$DST_DB" 'CREATE TABLE drill_extra (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES users(id))' > /dev/null
sql "$DST_DB" "INSERT INTO drill_extra VALUES ('x1', 'drill-u1')" > /dev/null
sql "$DST_DB" "INSERT INTO users (id, \"githubId\", \"githubLogin\", \"updatedAt\") VALUES ('drill-post', 'gh-post', 'written-after-dump', now())" > /dev/null
expect "users before the second restore" "$(sql "$DST_DB" 'SELECT count(*) FROM users')" 3
run_script restore.sh RESTORE_APP_SERVICE='' PG_DB="$DST_DB" -- --yes "$WORK/first.dump"
expect "users after the second restore" "$(sql "$DST_DB" 'SELECT count(*) FROM users')" "$EXPECT_USERS"
expect "row written after the dump" "$(sql "$DST_DB" "SELECT count(*) FROM users WHERE id = 'drill-post'")" 0
expect "table of the newer schema" "$(sql "$DST_DB" "SELECT coalesce(to_regclass('public.drill_extra')::text, 'gone')")" gone
expect "api keys after the second restore" "$(sql "$DST_DB" 'SELECT count(*) FROM api_keys')" "$EXPECT_KEYS"
expect "public schema owner" "$(sql "$DST_DB" "SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'public'")" pg_database_owner
pre=""
for f in "$WORK"/backups/deploy-panel-*.dump; do [ "$f" = "$dump" ] || pre="$f"; done
[ -n "$pre" ] || fail "no pre-restore dump was written"
# The pre-restore dump must hold the replaced state; read it back as SQL through the
# container (pg_restore is the only reader of the custom format).
pre_sql="$("$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" pg_restore -f - < "$pre")"
grep -q 'drill_extra' <<< "$pre_sql" || fail "the pre-restore dump lacks the newer table"
grep -q 'written-after-dump' <<< "$pre_sql" || fail "the pre-restore dump lacks the row written after the dump"
echo "roundtrip: ok: pre-restore dump holds the replaced state"

echo "roundtrip: a truncated dump must be refused and leave the database unchanged"
size="$(wc -c < "$dump" | tr -d ' ')"
head -c "$((size - 20))" "$dump" > "$WORK/truncated.dump"
if run_script restore.sh RESTORE_APP_SERVICE='' PG_DB="$DST_DB" -- --yes --no-pre-backup "$WORK/truncated.dump" 2> "$WORK/truncated.err"; then
  fail "restore.sh accepted a truncated dump"
fi
grep -q 'could not be read as a custom-format dump' "$WORK/truncated.err" || fail "truncated dump failed for another reason: $(cat "$WORK/truncated.err")"
expect "api keys after the truncated-dump restore" "$(sql "$DST_DB" 'SELECT count(*) FROM api_keys')" "$EXPECT_KEYS"

echo "roundtrip: a SQL copy that becomes unreadable after conversion must leave the database unchanged"
# restore.sh loads a private SQL copy. The shim deletes that copy when the pre-restore
# pg_dump runs (after conversion, before the load), so psql receives the schema reset
# but no dump; the transaction must not be committed.
tables_before="$(sql "$DST_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "$tables_before" -gt 0 ] || fail "expected tables before the vanish case, got $tables_before"
if run_script restore.sh DRILL_RM_ON_DUMP="$WORK/tmp/restore-dump.*" RESTORE_APP_SERVICE='' PG_DB="$DST_DB" \
  -- --yes "$WORK/first.dump" 2> "$WORK/vanish.err"; then
  fail "restore.sh reported success although its SQL copy vanished"
fi
grep -q 'nothing was committed' "$WORK/vanish.err" || fail "vanish case: unexpected message: $(cat "$WORK/vanish.err")"
expect "tables after the vanished-copy restore" \
  "$(sql "$DST_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")" "$tables_before"
expect "api keys after the vanished-copy restore" "$(sql "$DST_DB" 'SELECT count(*) FROM api_keys')" "$EXPECT_KEYS"
[ -z "$(find "$WORK/tmp" -mindepth 1)" ] || fail "temporary copy of the dump was left behind"

echo "roundtrip: backup.sh must not publish a truncated dump"
# backup.sh validates by reading the archive completely; feed the validator a real dump
# cut 20 bytes short (inside the data section, so the table of contents still lists
# fine and only a full read notices) through a shim whose pg_dump output is cut short.
CUT=$((size - 20))
mkdir -p "$WORK/shortbin"
cat > "$WORK/shortbin/docker" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = compose ] && [ "\$2" = -f ]; then
  shift 3
  case "\$1" in
    ps) echo db; exit 0 ;;
    exec)
      shift
      [ "\$1" = -T ] && shift
      shift # service name
      case "\$*" in
        *pg_dump*) "$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" "\$@" | head -c $CUT; exit 0 ;;
      esac
      exec "$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" "\$@"
      ;;
  esac
fi
echo "roundtrip docker shim: unexpected call: \$*" >&2
exit 9
SHIM
chmod +x "$WORK/shortbin/docker"
mkdir -p "$WORK/backups2"
if env PATH="$WORK/shortbin:$PATH" BACKUP_COMPOSE_FILE="$WORK/compose.yml" BACKUP_DIR="$WORK/backups2" \
  PG_USER="$PG_ROLE" PG_DB="$SRC_DB" "$REPO_ROOT/scripts/backup.sh" 2> "$WORK/short.err"; then
  fail "backup.sh published a dump cut off 20 bytes before its end"
fi
[ -z "$(find "$WORK/backups2" -mindepth 1)" ] || fail "backup.sh left files behind after a cut-off dump"
echo "roundtrip: ok: a cut-off dump is not published"

echo "roundtrip: the production container is refused"
if ( guard_container deploy-panel-db ) 2> "$WORK/guard.err"; then fail "guard_container accepted deploy-panel-db"; fi
grep -q 'production container' "$WORK/guard.err" || fail "guard_container failed for another reason: $(cat "$WORK/guard.err")"
echo "roundtrip: ok: the production container is refused"

sql postgres "DROP DATABASE $DST_DB" > /dev/null
sql postgres "DROP DATABASE $SRC_DB" > /dev/null
echo "roundtrip: PASSED"
