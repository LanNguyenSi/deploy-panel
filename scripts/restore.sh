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
#   5. starts the backend again, only after step 4 succeeded, and waits until it is
#      healthy. `docker compose start` returns as soon as the container is started, long
#      before the entrypoint has applied the schema and the healthcheck has passed, so a
#      backend that crash-loops on the restored data would look fine. The wait polls the
#      container's Docker healthcheck (`docker inspect`; no minimum compose version
#      needed) until it reports healthy twice in a row, one poll interval apart, with the
#      same restart count (a backend that crashes again within one poll interval is not
#      healthy; a crash later than that is not seen by this wait),
#      reports unhealthy or has exited, or RESTORE_WAIT_SECONDS pass. The backend applies its schema itself when it starts,
#      the same way it does after a deploy, so a dump that predates a schema change is
#      brought up to the deployed code then; this script does not run a schema tool of
#      its own. After a failure in step 4 the backend stays stopped on purpose: look at
#      the error first.
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
#   RESTORE_WAIT_SECONDS     how long to wait for the backend to become healthy (default: 120)
#   RESTORE_WAIT_POLL        seconds between two health polls, greater than 0 (default: 2)
#                            (leading zeros in RESTORE_WAIT_SECONDS are read as decimal)
#
# Exit codes:
#   0  restored, and the backend healthy (or no healthcheck to wait for: a warning says so),
#      or the backend was not started by this script (it was not running before, or
#      RESTORE_APP_SERVICE is empty)
#   1  dump invalid or unreadable, the backend could not be stopped (nothing changed), or
#      psql failed or the dump could not be read (not committed, database unchanged,
#      backend left stopped). Also the exit after SIGTERM/SIGINT/SIGHUP: the restore
#      state is then unknown, because the signal is handled only after the running
#      psql pipeline has finished, and that may have committed; the message says so
#   2  refused: no file, file missing, no --yes, compose file missing or the dev stack
#      file, db not running
#   3  the pre-restore dump failed; nothing was changed (use --no-pre-backup to go on)
#   4  the dump is restored (committed), but the backend did not start or did not become
#      healthy within RESTORE_WAIT_SECONDS; it may be stopped or restarting. Inspect it
#      with the printed `logs` command, start it with the printed `start` command
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$REPO_ROOT/docker-compose.prod.yml}"
DB_SERVICE="${BACKUP_DB_SERVICE:-db}"
APP_SERVICE="${RESTORE_APP_SERVICE-backend}"
PG_USER="${PG_USER:-deploy_panel}"
PG_DB="${PG_DB:-deploy_panel}"
WAIT_SECONDS="${RESTORE_WAIT_SECONDS:-120}"
WAIT_POLL="${RESTORE_WAIT_POLL:-2}"

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
# bash runs a trap only after the foreground command has finished, so a signal during
# the psql pipeline lets that pipeline complete, and it may have committed. Say so, and
# say how to bring the backend back.
start_hint=""
phase=prepare # prepare (nothing changed yet), load (psql pipeline running), loaded
on_signal() {
  case "$phase" in
    prepare) echo "restore: interrupted before the dump was loaded; the database is unchanged." >&2 ;;
    load) echo "restore: interrupted while the dump was being loaded. The state of database '$PG_DB' is unknown: the restore may have been committed or rolled back." >&2 ;;
    *) echo "restore: interrupted after the dump was loaded and committed." >&2 ;;
  esac
  [ -z "$start_hint" ] || echo "restore: the backend may be stopped; check the database, then start it with: $start_hint" >&2
  exit 1
}
trap on_signal HUP INT TERM

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

# Validated and normalised here, before anything is changed: bash reads a leading zero as
# octal ($((08)) is an error, $((010)) is 8), and an arithmetic error after the COMMIT
# would otherwise skip the health gate.
case "$WAIT_SECONDS" in '' | *[!0-9]*) refuse "RESTORE_WAIT_SECONDS must be a whole number of seconds, got '$WAIT_SECONDS'" ;; esac
[ "${#WAIT_SECONDS}" -le 9 ] || refuse "RESTORE_WAIT_SECONDS is too large: '$WAIT_SECONDS'"
WAIT_SECONDS=$((10#$WAIT_SECONDS))
[[ "$WAIT_POLL" =~ ^[0-9]+(\.[0-9]+)?$ ]] || refuse "RESTORE_WAIT_POLL must be a number of seconds, got '$WAIT_POLL'"
[[ "$WAIT_POLL" =~ ^0+(\.0+)?$ ]] && refuse "RESTORE_WAIT_POLL must be greater than 0, got '$WAIT_POLL'"

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
  # Set before the stop: a signal during the stop (up to its grace period) leaves the
  # backend stopped, and the message must say how to start it.
  start_hint="docker compose -f $COMPOSE_FILE start $APP_SERVICE"
  echo "restore: stopping $APP_SERVICE"
  if ! "${DC[@]}" stop "$APP_SERVICE"; then
    echo "restore: could not stop $APP_SERVICE; nothing was changed" >&2
    exit 1
  fi
  stopped_app=1
fi

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

# Sets health_result: healthy, nocheck (no healthcheck defined, container running), or
# why not (unhealthy, exited, no container, timeout after N seconds). `ps -a`: plain
# `ps -q` lists only running containers, so an exited backend would look like "no container".
# A healthy reading counts only when the next poll, one interval later, shows the same
# state and restart count. That catches a crash within one poll interval, not a later one:
# Docker keeps the last health status between its own checks.
health_result=""
wait_healthy() {
  local cid state prev_ok="" deadline=$((SECONDS + WAIT_SECONDS))
  while :; do
    cid="$("${DC[@]}" ps -a -q "$APP_SERVICE" 2> /dev/null | head -n 1)" || cid=""
    if [ -z "$cid" ]; then
      health_result="no container for $APP_SERVICE"
    else
      state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$cid" 2> /dev/null)" || state=""
      case "$state" in
        "running healthy "*)
          if [ "$state" = "$prev_ok" ]; then health_result=healthy; return 0; fi
          prev_ok="$state"
          health_result="not stably healthy after ${WAIT_SECONDS}s (last state: $state)"
          ;;
        "running none "*) health_result=nocheck; return 0 ;;
        exited* | dead*) health_result="${state%% *}"; return 0 ;;
        *unhealthy*) health_result="unhealthy"; return 0 ;;
        *) prev_ok=""; health_result="not healthy after ${WAIT_SECONDS}s (last state: ${state:-unknown})" ;;
      esac
    fi
    [ "$SECONDS" -lt "$deadline" ] || return 0
    sleep "$WAIT_POLL"
  done
}

echo "restore: restoring $file into database '$PG_DB'"
phase=load
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
phase=loaded

if [ "$stopped_app" -eq 1 ]; then
  echo "restore: starting $APP_SERVICE"
  if ! "${DC[@]}" start "$APP_SERVICE"; then
    echo "restore: the dump is restored, but $APP_SERVICE did not start; run: $start_hint" >&2
    exit 4
  fi
  wait_healthy || health_result="the health wait failed"
  case "$health_result" in
    healthy) echo "restore: $APP_SERVICE healthy" ;;
    nocheck) echo "restore: warning: $APP_SERVICE has no healthcheck, so only its start was confirmed, not that it works" >&2 ;;
    *)
      echo "restore: the dump is restored and committed, but $APP_SERVICE is not healthy ($health_result); it may be stopped or restarting." >&2
      echo "restore: inspect it with: docker compose -f $COMPOSE_FILE logs --tail 100 $APP_SERVICE ; start it with: $start_hint" >&2
      exit 4
      ;;
  esac
fi
# Reached only with the backend confirmed (or not stopped by this script): a branch above
# that left health_result unset must not fall through to success.
if [ "$stopped_app" -eq 1 ] && [ "$health_result" != healthy ] && [ "$health_result" != nocheck ]; then
  echo "restore: the dump is restored and committed, but the health of $APP_SERVICE was not confirmed; start it with: $start_hint" >&2
  exit 4
fi
echo "restore: done"
