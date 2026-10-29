#!/usr/bin/env bash
# Restore drill: proves that the newest dump written by scripts/backup.sh can be
# restored. It starts a throwaway Postgres container (no published port, its own
# random password), restores the dump into it with pg_restore, compares the row count
# of every table of the panel with the number of rows the dump itself holds for that
# table, and removes the container again. It never touches the production stack: the
# only docker commands it runs are `run`, `exec` and `rm -f` on the one container it
# created, named <prefix>-<pid>.
#
# The expected counts do not come from the live database (which keeps changing after
# the dump) but from the dump: `pg_restore -f -` writes every table as a COPY block,
# one line per row, and those lines are counted independently of the restore. A restore
# that loses rows, or a table that is missing from the dump, fails the drill.
#
# Usage:   scripts/restore-drill.sh [dump-file]
#          Without a file the newest deploy-panel-*.dump in BACKUP_DIR is used.
# Cron:    a monthly drill is enough, for example
#          23 4 1 * * cd /path/to/deploy-panel && scripts/restore-drill.sh >> "$HOME/deploy-panel-drill.log" 2>&1
#
# Environment (all optional; an empty value counts as unset and the default applies):
#   BACKUP_DIR           where the dumps are (default: $HOME/deploy-panel-backups)
#   DRILL_IMAGE          Postgres image of the throwaway container (default: postgres:16-alpine,
#                        the major version of docker-compose.prod.yml; use the same one)
#   DRILL_CONTAINER_PREFIX  container name prefix (default: deploy-panel-drill)
#   DRILL_WAIT_TRIES     seconds to wait for the throwaway database (default: 60)
#   PG_USER / PG_DB      role and database the dump was taken from (default: deploy_panel /
#                        deploy_panel); the throwaway container is created with the same
#                        role and database name so owners in the dump resolve
#
# Exit codes:
#   0  restored and every row count matches the dump
#   1  restore failed, or at least one row count differs from the dump
#   2  refused before starting a container: no dump, dump unreadable or too small, bad
#      configuration, docker not available
set -euo pipefail

# Every table of backend/prisma/schema.prisma (the @@map names). A new model belongs here;
# scripts/restore-drill.test.sh compares this list with the schema file.
TABLES=(servers apps app_secrets env_var_changes users sessions api_keys deploys audit_logs scheduled_deploys)

IMAGE="${DRILL_IMAGE:-postgres:16-alpine}"
PREFIX="${DRILL_CONTAINER_PREFIX:-deploy-panel-drill}"
WAIT_TRIES="${DRILL_WAIT_TRIES:-60}"
PG_USER="${PG_USER:-deploy_panel}"
PG_DB="${PG_DB:-deploy_panel}"

refuse() { echo "drill: $*" >&2; exit 2; }
fail() { echo "drill: FAIL: $*" >&2; exit 1; }

case "$WAIT_TRIES" in ''|*[!0-9]*) refuse "DRILL_WAIT_TRIES must be a positive integer, got '$WAIT_TRIES'" ;; esac
[ "$WAIT_TRIES" -ge 1 ] || refuse "DRILL_WAIT_TRIES must be at least 1"
[ "$#" -le 1 ] || refuse "usage: restore-drill.sh [dump-file]"

if [ "$#" -eq 1 ] && [ -n "$1" ]; then
  dump="$1"
else
  if [ -z "${BACKUP_DIR:-}" ]; then
    [ -n "${HOME:-}" ] || refuse "HOME is not set and neither a dump file nor BACKUP_DIR is given"
    BACKUP_DIR="$HOME/deploy-panel-backups"
  fi
  [ -d "$BACKUP_DIR" ] || refuse "backup directory not found: $BACKUP_DIR"
  # Names are machine-generated (deploy-panel-<timestamp>.dump), so ls -t is safe here.
  # shellcheck disable=SC2012
  dump="$(ls -t "$BACKUP_DIR"/deploy-panel-*.dump 2>/dev/null | head -n 1 || true)"
  [ -n "$dump" ] || refuse "no deploy-panel-*.dump in $BACKUP_DIR"
fi
[ -f "$dump" ] || refuse "dump file not found: $dump"
size="$(wc -c < "$dump" | tr -d ' ')"
[ "$size" -ge 1024 ] || refuse "$dump is too small ($size bytes) to be a dump"
command -v docker > /dev/null 2>&1 || refuse "docker is not available"

name="$PREFIX-$$"
started=0
cleanup() {
  if [ "$started" -eq 1 ]; then
    docker rm -f "$name" > /dev/null 2>&1 || echo "drill: could not remove the container $name; remove it by hand: docker rm -f $name" >&2
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# A password nobody needs to know: the container publishes no port.
password="drill-$$-$RANDOM$RANDOM"
echo "drill: dump $dump ($size bytes), throwaway container $name ($IMAGE)"
# Set before the call: if docker creates the container and then fails, the trap still
# tries to remove it.
started=1
docker run -d --name "$name" \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB="$PG_DB" \
  "$IMAGE" > /dev/null || fail "could not start the throwaway container"

# The image's init phase runs a temporary server on the unix socket only; a TCP
# connection works only once the real server is up.
ready=0
for _ in $(seq 1 "$WAIT_TRIES"); do
  if docker exec "$name" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -tA -c 'SELECT 1' > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "the throwaway database was not ready after $WAIT_TRIES seconds"

echo "drill: restoring"
docker exec -i "$name" pg_restore --exit-on-error --no-owner -U "$PG_USER" -d "$PG_DB" < "$dump" \
  || fail "pg_restore failed (truncated or corrupt dump, or a dump from another Postgres major version)"

# Expected rows per table: the data lines of its COPY block in the dump.
expected="$(docker exec -i "$name" pg_restore -f - < "$dump" | awk '
  /^COPY / { t = $2; sub(/^public\./, "", t); gsub(/"/, "", t); in_copy = 1; n[t] = 0; next }
  in_copy && /^\\\.$/ { in_copy = 0; next }
  in_copy { n[t]++ }
  END { for (t in n) print t, n[t] }
')" || fail "could not read the table contents of the dump"

bad=0
total=0
for t in "${TABLES[@]}"; do
  want="$(awk -v t="$t" '$1 == t { print $2 }' <<< "$expected")"
  if [ -z "$want" ]; then
    echo "drill: MISSING: table $t is not in the dump" >&2
    bad=1
    continue
  fi
  got="$(docker exec "$name" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -tA -c "SELECT count(*) FROM \"$t\"")" || got="error"
  if [ "$got" = "$want" ]; then
    echo "drill: ok: $t = $got"
    total=$((total + got))
  else
    echo "drill: MISMATCH: $t has $got rows after the restore, the dump holds $want" >&2
    bad=1
  fi
done

[ "$bad" -eq 0 ] || fail "restored database differs from the dump"
if [ "$total" -eq 0 ]; then
  echo "drill: warning: the dump holds no rows at all; the restore itself worked, but nothing was compared" >&2
fi
echo "drill: PASSED ($total rows in ${#TABLES[@]} tables)"
