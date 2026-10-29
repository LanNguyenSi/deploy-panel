#!/usr/bin/env bash
# Postgres backup for the production stack (docker-compose.prod.yml).
#
# Writes one custom-format pg_dump (-Fc, compressed) per run into BACKUP_DIR as
# deploy-panel-<YYYYMMDD_HHMMSS>.dump. The dump goes through
# `docker compose exec -T db pg_dump`, so no Postgres client is needed on the host and
# the database stays on its private network. BACKUP_DIR defaults to a directory
# OUTSIDE the checkout: agent-relay refuses to deploy a tree with untracked files, the
# Docker build context is the repository root, and the dump holds user, session, API key
# hash, relay token and encrypted app secret rows. A BACKUP_DIR inside the checkout is refused.
#
# Safe against partial files: the dump is written to a hidden temp file in BACKUP_DIR
# and validated by reading it completely with `pg_restore` inside the db container (a
# truncated or corrupt custom-format archive makes pg_restore fail; `pg_restore --list`
# alone reads only the table of contents and would accept a file cut off after it).
# Only a validated file is renamed to its final name, so a failed run never leaves a
# truncated or empty deploy-panel-*.dump behind.
#
# Usage:   scripts/backup.sh
# Cron:    17 3 * * * cd /path/to/deploy-panel && scripts/backup.sh >> "$HOME/deploy-panel-backup.log" 2>&1
#          (the log lives under $HOME: /var/log is not writable for the docker-group
#          user that runs the job, and a redirect that cannot open its file means the
#          script never runs at all)
#
# Environment (all optional; an empty value counts as unset and the default applies):
#   BACKUP_COMPOSE_FILE  compose file of the stack (default: <repo>/docker-compose.prod.yml).
#                        The dev stack file docker-compose.yml of this checkout is refused.
#   BACKUP_DB_SERVICE    compose service that runs Postgres (default: db)
#   BACKUP_DIR           target directory (default: $HOME/deploy-panel-backups); created
#                        with mode 700 when missing. Refused (exit 2) inside the checkout.
#   PG_USER / PG_DB      database user and name (default: deploy_panel / deploy_panel)
#   KEEP_FILES           keep at most this many dumps (default: 14)
#   KEEP_DAYS            delete dumps older than this many days (default: 14)
#   BACKUP_SKIP_ROTATION set to a non-empty value to skip the rotation (scripts/restore.sh
#                        does this for its pre-restore dump, so that dump can never age
#                        out the file that is being restored)
#   BACKUP_OFFHOST_HOOK  executable that copies the finished dump off this host; called
#                        with the dump path as its only argument. The dump holds users,
#                        sessions, API key hashes, relay tokens and encrypted app secrets: encrypt it in the hook
#                        before it leaves the host.
#
# Exit codes:
#   0  dump written and validated (hook, if set, succeeded; rotation done)
#   1  pg_dump failed or the dump failed validation (nothing published)
#   2  refused before dumping: bad configuration, BACKUP_DIR inside the checkout, compose
#      file missing or the dev stack file, or the db service is not running
#   3  dump is published and valid, but the off-host hook failed (rotation is skipped so
#      a broken off-host copy never pushes older dumps out)
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$REPO_ROOT/docker-compose.prod.yml}"
DB_SERVICE="${BACKUP_DB_SERVICE:-db}"
PG_USER="${PG_USER:-deploy_panel}"
PG_DB="${PG_DB:-deploy_panel}"
KEEP_FILES="${KEEP_FILES:-14}"
KEEP_DAYS="${KEEP_DAYS:-14}"
OFFHOST_HOOK="${BACKUP_OFFHOST_HOOK:-}"
SKIP_ROTATION="${BACKUP_SKIP_ROTATION:-}"

refuse() { echo "backup: $*" >&2; exit 2; }

# The default needs HOME; an explicit BACKUP_DIR does not.
if [ -z "${BACKUP_DIR:-}" ]; then
  [ -n "${HOME:-}" ] || refuse "HOME is not set and BACKUP_DIR is not given"
  BACKUP_DIR="$HOME/deploy-panel-backups"
fi

case "$KEEP_FILES" in ''|*[!0-9]*) refuse "KEEP_FILES must be a positive integer, got '$KEEP_FILES'" ;; esac
case "$KEEP_DAYS" in ''|*[!0-9]*) refuse "KEEP_DAYS must be a positive integer, got '$KEEP_DAYS'" ;; esac
[ "$KEEP_FILES" -ge 1 ] || refuse "KEEP_FILES must be at least 1"
[ "$KEEP_DAYS" -ge 1 ] || refuse "KEEP_DAYS must be at least 1"
[ -f "$COMPOSE_FILE" ] || refuse "compose file not found: $COMPOSE_FILE"
if [ -n "$OFFHOST_HOOK" ] && { [ ! -f "$OFFHOST_HOOK" ] || [ ! -x "$OFFHOST_HOOK" ]; }; then
  refuse "BACKUP_OFFHOST_HOOK is not an executable file: $OFFHOST_HOOK"
fi

phys_repo="$(cd "$REPO_ROOT" && pwd -P)"

# The dev stack (docker-compose.yml) has its own throwaway database; backing it up
# (or, in restore.sh, replacing it) from a production script is always a mistake.
# The -ef test also catches a file symlink or hardlink to it; a copy is not caught.
phys_compose="$(cd "$(dirname "$COMPOSE_FILE")" && pwd -P)/$(basename "$COMPOSE_FILE")"
if [ "$phys_compose" = "$phys_repo/docker-compose.yml" ] || [ "$COMPOSE_FILE" -ef "$REPO_ROOT/docker-compose.yml" ]; then
  refuse "$COMPOSE_FILE is the development stack; this script only handles docker-compose.prod.yml"
fi

# A dump inside the checkout would block the next relay deploy (untracked file) and enter
# every docker build context. Resolve through the nearest existing ancestor so symlinks
# and a not yet created directory are judged by where they really are.
case "$BACKUP_DIR" in /*) abs_dir="$BACKUP_DIR" ;; *) abs_dir="$PWD/$BACKUP_DIR" ;; esac
anc="$abs_dir"
while [ ! -d "$anc" ]; do anc="$(dirname "$anc")"; done
missing="${abs_dir#"$anc"}"
case "$missing/" in
  */../*) refuse "BACKUP_DIR $BACKUP_DIR has a '..' in a part that does not exist yet; give a plain path" ;;
esac
phys_dir="$(cd "$anc" && pwd -P)$missing"
case "$phys_dir/" in
  "$phys_repo/"*) refuse "BACKUP_DIR $BACKUP_DIR is inside the checkout; use a directory outside it (default: \$HOME/deploy-panel-backups)" ;;
esac

DC=(docker compose -f "$COMPOSE_FILE")

# The db service must be running: a stack that is down, or another stack than the one in
# COMPOSE_FILE, has no such container, and a cron job must not report success for it.
running="$("${DC[@]}" ps --status running --services)" \
  || refuse "docker compose could not list the services of $COMPOSE_FILE"
grep -qx "$DB_SERVICE" <<< "$running" \
  || refuse "service '$DB_SERVICE' is not running in $COMPOSE_FILE; start the production stack first"

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
# Reap temp files left behind by a SIGKILL'd run or a reboot mid-dump.
find "$BACKUP_DIR" -maxdepth 1 -name '.deploy-panel-*.dump.tmp' -mtime +1 -delete
tmp="$BACKUP_DIR/.deploy-panel-$ts.$$.dump.tmp"
out="$BACKUP_DIR/deploy-panel-$ts.dump"
# Two runs in the same second (a cron job and a pre-restore dump) must not overwrite
# each other.
if [ -e "$out" ]; then out="$BACKUP_DIR/deploy-panel-$ts-$$.dump"; fi

cleanup() { rm -f "$tmp"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Straight redirect into the temp file, no pipe: the exit status of pg_dump is the one
# tested here, and nothing is published before the validation below.
"${DC[@]}" exec -T "$DB_SERVICE" pg_dump -Fc -U "$PG_USER" "$PG_DB" > "$tmp" \
  || { echo "backup: pg_dump failed, nothing published" >&2; exit 1; }

# Validate before publishing: non-trivial size, then a complete read of the archive.
size="$(wc -c < "$tmp" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "backup: dump too small ($size bytes), refusing to keep it" >&2
  exit 1
fi
if ! "${DC[@]}" exec -T "$DB_SERVICE" pg_restore -f /dev/null < "$tmp"; then
  echo "backup: pg_restore could not read the whole dump (truncated or corrupt), refusing to keep it" >&2
  exit 1
fi

mv "$tmp" "$out"
echo "backup: wrote $out ($size bytes)"

if [ -n "$OFFHOST_HOOK" ]; then
  if "$OFFHOST_HOOK" "$out"; then
    echo "backup: off-host hook done"
  else
    echo "backup: off-host hook failed; the local dump is kept, rotation skipped" >&2
    exit 3
  fi
fi

if [ -n "$SKIP_ROTATION" ]; then
  echo "backup: rotation skipped (BACKUP_SKIP_ROTATION)"
  exit 0
fi

# Rotation: keep at most KEEP_FILES dumps and nothing older than KEEP_DAYS days.
# Names are machine-generated (deploy-panel-<timestamp>.dump), so ls -t is safe here.
n=0
# shellcheck disable=SC2012
while IFS= read -r f; do
  n=$((n + 1))
  if [ "$n" -gt "$KEEP_FILES" ]; then rm -f "$f"; fi
done < <(ls -t "$BACKUP_DIR"/deploy-panel-*.dump 2>/dev/null || true)
# The dump just written is never aged out, even with a skewed clock.
find "$BACKUP_DIR" -maxdepth 1 -name 'deploy-panel-*.dump' ! -path "$out" -mtime +"$KEEP_DAYS" -delete
kept="$(find "$BACKUP_DIR" -maxdepth 1 -name 'deploy-panel-*.dump' | wc -l | tr -d ' ')"
echo "backup: rotation done ($kept dumps kept)"
