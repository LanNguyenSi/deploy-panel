#!/usr/bin/env bash
# Restore a dump written by scripts/backup.sh into the running production stack
# (docker-compose.prod.yml).
#
# Usage: scripts/restore.sh --yes [--no-pre-backup] <dump-file>
#
# DESTRUCTIVE: the whole `public` schema is dropped and recreated, then the dump is
# loaded into it. Every table, view and sequence that exists now and is not in the dump
# is gone (a table a newer release added, with a foreign key into a table the dump also
# has, included), and rows written after the dump are lost. Without --yes the script only
# says what it would do and exits 2; there is no interactive prompt, so a cron job or a
# pasted command cannot restore by accident.
#
# What it does, in order:
#   1. checks the file argument and the compose file, checks that the db service is
#      running, and converts the custom-format dump to SQL with `pg_restore -f -` inside
#      the db container into a private temporary file. pg_restore reads the whole archive,
#      so a truncated or corrupt file fails here, before anything is changed; the file is
#      read once and everything below uses the SQL copy, so a file that is rotated away,
#      truncated or replaced meanwhile cannot change what is loaded. The SQL is checked
#      too (completion marker, no transaction control statements),
#   2. stops the backend service when it is running (it holds connections that would
#      block the DROPs and writes rows while the schema is replaced),
#   3. takes a dump of the CURRENT state with scripts/backup.sh into BACKUP_DIR (rotation
#      skipped), unless --no-pre-backup; a failure ends the run before anything is changed
#      and the backend is started again,
#   4. pipes `BEGIN;`, `DROP SCHEMA public CASCADE; CREATE SCHEMA public ...`, the SQL and,
#      only when the whole SQL was read successfully, `COMMIT;` into psql with
#      ON_ERROR_STOP=1. psql is not given --single-transaction because that commits at end
#      of input: an input that ends early (the copy unreadable) would commit a dropped,
#      empty schema. Without the final COMMIT the session ends in a rollback, so any error
#      or short input leaves the database with its old content,
#   5. starts the backend again, only after step 4 succeeded. The backend applies its
#      schema itself when it starts, the same way it does after a deploy, so a dump that
#      predates a schema change is brought up to the deployed code then; this script does
#      not run a schema tool of its own. After a failure the backend stays stopped on
#      purpose: look at the error first.
#
# A pre-restore dump of an (almost) empty database is below backup.sh's size floor and
# fails validation: restore into a fresh database with --no-pre-backup.
#
# Environment (all optional; the compose, db and dump variables are the ones of backup.sh):
#   BACKUP_COMPOSE_FILE      compose file of the stack (default: <repo>/docker-compose.prod.yml);
#                            the dev stack file docker-compose.yml of this checkout is refused
#   BACKUP_DB_SERVICE        Postgres service (default: db)
#   BACKUP_DIR               where the pre-restore dump goes (default: $HOME/deploy-panel-backups)
#   RESTORE_APP_SERVICE      service stopped during the restore (default: backend; empty = leave alone)
#   PG_USER / PG_DB          database user and name (default: deploy_panel / deploy_panel)
#
# Exit codes:
#   0  restored (backend started)
#   1  dump invalid or unreadable, the backend could not be stopped (nothing changed), or
#      psql failed or the dump could not be read (not committed, database unchanged,
#      backend left stopped)
#   2  refused: no file, file missing, no --yes, compose file missing or the dev stack
#      file, db not running
#   3  the pre-restore dump failed; nothing was changed (use --no-pre-backup to go on)
#   4  the dump is restored, but the backend did not start; run the printed command by hand
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$REPO_ROOT/docker-compose.prod.yml}"
DB_SERVICE="${BACKUP_DB_SERVICE:-db}"
APP_SERVICE="${RESTORE_APP_SERVICE-backend}"
PG_USER="${PG_USER:-deploy_panel}"
PG_DB="${PG_DB:-deploy_panel}"

# The public schema as a fresh PostgreSQL 16 database has it (owner, comment, USAGE
# for everyone), so a restored database matches one created by initdb. The SET keeps
# the dozens of "drop cascades to ..." notices out of the output.
RESET_SQL='SET client_min_messages = warning;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION pg_database_owner;
COMMENT ON SCHEMA public IS '"'"'standard public schema'"'"';
GRANT USAGE ON SCHEMA public TO PUBLIC;'

# Private SQL copy of the dump, removed on every exit path.
tmp=""
cleanup() { [ -z "$tmp" ] || rm -f "$tmp"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

usage="usage: restore.sh --yes [--no-pre-backup] <dump-file>"
refuse() { echo "restore: $*" >&2; exit 2; }

confirmed=0
pre_backup=1
file=""
for arg in "$@"; do
  case "$arg" in
    --yes) confirmed=1 ;;
    --no-pre-backup) pre_backup=0 ;;
    -*) refuse "unknown option '$arg' ($usage)" ;;
    *)
      [ -z "$file" ] || refuse "more than one file given ($usage)"
      file="$arg"
      ;;
  esac
done

[ -n "$file" ] || refuse "no dump file given ($usage)"
[ -f "$file" ] || refuse "dump file not found: $file"
[ -f "$COMPOSE_FILE" ] || refuse "compose file not found: $COMPOSE_FILE"

# The dev stack (docker-compose.yml) has its own throwaway database; never replace it
# from here, and never act on it by accident on the production host.
# The -ef test also catches a file symlink or hardlink to it; a copy is not caught.
phys_repo="$(cd "$REPO_ROOT" && pwd -P)"
phys_compose="$(cd "$(dirname "$COMPOSE_FILE")" && pwd -P)/$(basename "$COMPOSE_FILE")"
if [ "$phys_compose" = "$phys_repo/docker-compose.yml" ] || [ "$COMPOSE_FILE" -ef "$REPO_ROOT/docker-compose.yml" ]; then
  refuse "$COMPOSE_FILE is the development stack; this script only handles docker-compose.prod.yml"
fi

if [ "$confirmed" -ne 1 ]; then
  echo "restore: would replace the content of database '$PG_DB' (compose file $COMPOSE_FILE) with $file." >&2
  refuse "this destroys everything not in the dump, including rows written after it; run again with --yes to proceed"
fi

size="$(wc -c < "$file" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "restore: $file is too small ($size bytes) to be a dump" >&2
  exit 1
fi

DC=(docker compose -f "$COMPOSE_FILE")
running="$("${DC[@]}" ps --status running --services)" \
  || refuse "docker compose could not list the services of $COMPOSE_FILE"
grep -qx "$DB_SERVICE" <<< "$running" \
  || refuse "service '$DB_SERVICE' is not running in $COMPOSE_FILE; start the db first"

echo "restore: compose file $COMPOSE_FILE, database '$PG_DB', dump $file"

# Work on a private SQL copy: the later steps (stopping the backend, the pre-restore
# dump) take time, and the file may be rotated away or truncated in between. pg_restore
# fails on a truncated or corrupt archive, and a failed conversion leaves nothing behind.
tmp="$(umask 077 && mktemp "${TMPDIR:-/tmp}/restore-dump.XXXXXX")" \
  || { echo "restore: could not create a temporary file" >&2; exit 1; }
if ! "${DC[@]}" exec -T "$DB_SERVICE" pg_restore -f - < "$file" > "$tmp"; then
  echo "restore: $file could not be read as a custom-format dump (truncated or corrupt?); nothing was changed" >&2
  exit 1
fi
if ! grep -qx -- '-- PostgreSQL database dump complete' "$tmp"; then
  echo "restore: the SQL read from $file is missing the completion marker; nothing was changed" >&2
  exit 1
fi
# The restore runs inside the transaction opened here; a COMMIT or similar line in the
# dump would end it early and make the later error handling a lie. pg_restore output has
# none at the start of a line.
if grep -q -i -E '^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT)[[:space:]]*;' "$tmp"; then
  echo "restore: $file contains transaction control statements; refusing to load it" >&2
  exit 1
fi

stopped_app=0
if [ -n "$APP_SERVICE" ] && grep -qx "$APP_SERVICE" <<< "$running"; then
  echo "restore: stopping $APP_SERVICE"
  if ! "${DC[@]}" stop "$APP_SERVICE"; then
    echo "restore: could not stop $APP_SERVICE; nothing was changed" >&2
    exit 1
  fi
  stopped_app=1
fi
start_hint="docker compose -f $COMPOSE_FILE start $APP_SERVICE"

if [ "$pre_backup" -eq 1 ]; then
  echo "restore: backing up the current state first (scripts/backup.sh)"
  if ! BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DB_SERVICE="$DB_SERVICE" PG_USER="$PG_USER" PG_DB="$PG_DB" \
    BACKUP_SKIP_ROTATION=1 "$SCRIPT_DIR/backup.sh"; then
    echo "restore: the pre-restore backup failed; nothing was changed. Fix it, or pass --no-pre-backup to restore without it" >&2
    if [ "$stopped_app" -eq 1 ]; then
      echo "restore: starting $APP_SERVICE again"
      "${DC[@]}" start "$APP_SERVICE" || echo "restore: could not start $APP_SERVICE; run: $start_hint" >&2
    fi
    exit 3
  fi
fi

echo "restore: restoring $file into database '$PG_DB'"
# COMMIT is sent only when the whole copy was read: if cat fails, psql sees end of
# input inside the open transaction and rolls it back (pipefail turns the failure of
# the left side into the failure of the pipeline).
if ! { printf 'BEGIN;\n%s\n' "$RESET_SQL"; cat "$tmp" && printf 'COMMIT;\n'; } \
  | "${DC[@]}" exec -T "$DB_SERVICE" psql -v ON_ERROR_STOP=1 -q \
    -U "$PG_USER" -d "$PG_DB" > /dev/null; then
  echo "restore: psql failed or the dump could not be read; nothing was committed, the database is unchanged" >&2
  [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: $start_hint" >&2
  exit 1
fi

if [ "$stopped_app" -eq 1 ]; then
  echo "restore: starting $APP_SERVICE"
  if ! "${DC[@]}" start "$APP_SERVICE"; then
    echo "restore: the dump is restored, but $APP_SERVICE did not start; run: $start_hint" >&2
    exit 4
  fi
fi
echo "restore: done"
