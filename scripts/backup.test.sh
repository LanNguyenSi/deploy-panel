#!/usr/bin/env bash
# Test driver for scripts/backup.sh. A fake `docker` on PATH stands in for compose,
# so no container or Postgres is needed. Run directly or from CI:
#   bash scripts/backup.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# The cases below set every input explicitly; nothing may leak in from the caller.
unset BACKUP_DIR BACKUP_COMPOSE_FILE BACKUP_DB_SERVICE BACKUP_SKIP_ROTATION BACKUP_OFFHOST_HOOK KEEP_FILES KEEP_DAYS PG_USER PG_DB

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"; rm -f "$REPO/.hardlink-compose.yml"' EXIT
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

# Never run the script under test against the real HOME.
export HOME="$WORKDIR/home"
mkdir -p "$HOME"

export FAKE_DOCKER_LOG="$WORKDIR/docker.log"
COMPOSE_FILE="$WORKDIR/compose.yml"
: > "$COMPOSE_FILE"

fail_count=0
pass_count=0
pass() { pass_count=$((pass_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); echo "FAIL: $1"; }

# A stand-in for a custom-format archive: the fake pg_restore accepts it only when it
# ends with the end-of-archive line, the way the real one rejects a cut-off archive.
valid_dump_body() {
  printf 'FAKEPGDMP header\n'
  for i in $(seq 1 200); do printf 'table data row %d\n' "$i"; done
  printf 'FAKE-ARCHIVE-END\n'
}
valid_dump_body > "$WORKDIR/valid_dump.dump"

# Fake docker. FAKE_RUNNING lists the running compose services, FAKE_MODE picks what
# `exec ... pg_dump` does, FAKE_RESTORE_FAIL=1 makes `exec ... pg_restore` fail. Every
# call is logged.
cat > "$FAKE_BIN/docker" <<EOF2
#!/usr/bin/env bash
echo "\$*" >> "\$FAKE_DOCKER_LOG"
case "\$*" in
  *" ps "*) [ "\${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' \${FAKE_RUNNING:-backend db}; exit 0 ;;
  *" exec "*pg_dump*)
    case "\${FAKE_MODE:-valid}" in
      valid) cat "$WORKDIR/valid_dump.dump" ;;
      fail) echo "pg_dump: fatal error" >&2; exit 1 ;;
      empty) exit 0 ;;
      tiny) echo "FAKE-ARCHIVE-END" ;;
      cut_off) head -c 1500 "$WORKDIR/valid_dump.dump" ;;
      partial_fail) head -c 600 "$WORKDIR/valid_dump.dump"; exit 1 ;;
    esac ;;
  *" exec "*pg_restore*)
    cat > "$WORKDIR/restore_stdin"
    [ "\${FAKE_RESTORE_FAIL:-0}" = 1 ] && { echo "pg_restore: error" >&2; exit 1; }
    [ "\$(tail -n 1 "$WORKDIR/restore_stdin")" = "FAKE-ARCHIVE-END" ] || { echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1; }
    exit 0 ;;
  *) echo "fake docker: unexpected call: \$*" >&2; exit 9 ;;
esac
EOF2
chmod +x "$FAKE_BIN/docker"

# `date` is fixed when FAKE_DATE is set (to force two runs into the same second).
REAL_DATE="$(command -v date)"
cat > "$FAKE_BIN/date" <<EOF3
#!/usr/bin/env bash
if [ -n "\${FAKE_DATE:-}" ]; then echo "\$FAKE_DATE"; else exec "$REAL_DATE" "\$@"; fi
EOF3
chmod +x "$FAKE_BIN/date"

# run_backup_raw [VAR=value ...]: BACKUP_DIR is NOT set unless given; sets rc, out_text
run_backup_raw() {
  : > "$FAKE_DOCKER_LOG"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" "$@" "$BACKUP_SCRIPT" 2>&1)" || rc=$?
}
# run_backup <dir> [VAR=value ...]
run_backup() {
  local dir="$1"; shift
  run_backup_raw BACKUP_DIR="$dir" "$@"
}
count_dumps() { { find "$1" -maxdepth 1 -name 'deploy-panel-*.dump' 2>/dev/null || true; } | wc -l | tr -d ' '; }
count_tmp() { { find "$1" -maxdepth 1 -name '.*.tmp' 2>/dev/null || true; } | wc -l | tr -d ' '; }
# make_old <dir> <name> <touch -t stamp>: an existing dump with a given age
make_old() { echo old > "$1/$2"; touch -t "$3" "$1/$2"; }

# (a) success: published, mode 600/700, exact command lines, content intact
{
  d="$WORKDIR/a"
  run_backup "$d"
  f="$(find "$d" -maxdepth 1 -name 'deploy-panel-*.dump' | head -1)"
  mode_f="$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")"
  mode_d="$(stat -c %a "$d" 2>/dev/null || stat -f %Lp "$d")"
  if [ "$rc" -eq 0 ] && [ "$(count_dumps "$d")" = 1 ] && [ "$(count_tmp "$d")" = 0 ] \
    && cmp -s "$f" "$WORKDIR/valid_dump.dump" && [ "$mode_f" = 600 ] && [ "$mode_d" = 700 ] \
    && grep -q "compose -f $COMPOSE_FILE exec -T db pg_dump -Fc -U deploy_panel deploy_panel" "$FAKE_DOCKER_LOG" \
    && grep -q "compose -f $COMPOSE_FILE exec -T db pg_restore -f /dev/null" "$FAKE_DOCKER_LOG"; then
    pass "(a) success: dump published with 600/700 modes, pg_dump -Fc and a full pg_restore read"
  else
    fail "(a) success: rc=$rc files=$(count_dumps "$d") modes=$mode_f/$mode_d"
  fi
}

# (a2) PG_USER / PG_DB are passed through to pg_dump
{
  d="$WORKDIR/a2"
  run_backup "$d" PG_USER=other_user PG_DB=other_db
  if [ "$rc" -eq 0 ] && grep -q "pg_dump -Fc -U other_user other_db" "$FAKE_DOCKER_LOG"; then
    pass "(a2) PG_USER / PG_DB override the defaults"
  else
    fail "(a2) PG_USER/PG_DB: rc=$rc"
  fi
}

# (b) db service not running -> exit 2, no pg_dump call, nothing written
{
  d="$WORKDIR/b"
  run_backup "$d" FAKE_RUNNING=backend
  if [ "$rc" -eq 2 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG" && [ ! -d "$d" ] && grep -q "not running" <<< "$out_text"; then
    pass "(b) db not running -> exit 2, no dump attempted"
  else
    fail "(b) db not running: rc=$rc"
  fi
}

# (b2) a service whose name only contains "db" is not the db service; BACKUP_DB_SERVICE picks another
{
  d="$WORKDIR/b2"
  run_backup "$d" FAKE_RUNNING="backend mydb"; r1=$rc; n1=0; grep -q pg_dump "$FAKE_DOCKER_LOG" && n1=1
  run_backup "$d" FAKE_RUNNING="backend mydb" BACKUP_DB_SERVICE=mydb; r2=$rc; n2=0; grep -q "exec -T mydb pg_dump" "$FAKE_DOCKER_LOG" && n2=1
  if [ "$r1" = 2 ] && [ "$n1" = 0 ] && [ "$r2" = 0 ] && [ "$n2" = 1 ]; then
    pass "(b2) service name must match exactly; BACKUP_DB_SERVICE is honoured"
  else
    fail "(b2) service name: $r1 $n1 $r2 $n2"
  fi
}

# (b3) compose ps itself fails -> exit 2
{
  d="$WORKDIR/b3"
  run_backup "$d" FAKE_PS_FAIL=1
  if [ "$rc" -eq 2 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG"; then
    pass "(b3) compose ps failure -> exit 2"
  else
    fail "(b3) compose ps failure: rc=$rc"
  fi
}

# (c) pg_dump fails -> exit 1, nothing published, no temp left
{
  d="$WORKDIR/c"
  run_backup "$d" FAKE_MODE=fail
  if [ "$rc" -eq 1 ] && [ "$(count_dumps "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ]; then
    pass "(c) pg_dump failure -> exit 1, no dump, no temp"
  else
    fail "(c) pg_dump failure: rc=$rc dumps=$(count_dumps "$d") tmp=$(count_tmp "$d")"
  fi
}

# (c2) pg_dump fails after writing a valid-looking prefix -> still refused
{
  d="$WORKDIR/c2"
  run_backup "$d" FAKE_MODE=partial_fail
  if [ "$rc" -eq 1 ] && [ "$(count_dumps "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ]; then
    pass "(c2) failing pg_dump with partial output -> nothing published"
  else
    fail "(c2) partial failing dump: rc=$rc dumps=$(count_dumps "$d")"
  fi
}

# (d) validation: empty, tiny, cut off with exit 0 (the read-through must catch it) -> exit 1,
#     nothing published; and the same for a complete file that pg_restore rejects
for mode in empty tiny cut_off; do
  d="$WORKDIR/d_$mode"
  run_backup "$d" FAKE_MODE="$mode"
  want="dump too small"; [ "$mode" != cut_off ] || want="pg_restore could not read"
  if [ "$rc" -eq 1 ] && [ "$(count_dumps "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ] && { [ "$mode" = empty ] || grep -q "$want" <<< "$out_text"; }; then
    pass "(d) validation refuses mode=$mode"
  else
    fail "(d) validation mode=$mode: rc=$rc dumps=$(count_dumps "$d") tmp=$(count_tmp "$d")"
  fi
done
{
  d="$WORKDIR/d_restore_fail"
  run_backup "$d" FAKE_RESTORE_FAIL=1
  if [ "$rc" -eq 1 ] && [ "$(count_dumps "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ] && grep -q "pg_restore could not read" <<< "$out_text"; then
    pass "(d) a dump pg_restore cannot read is not published"
  else
    fail "(d) pg_restore rejects: rc=$rc dumps=$(count_dumps "$d")"
  fi
}

# (e) rotation, KEEP_FILES alone: 5 old dumps, KEEP_FILES=3 (KEEP_DAYS wide) -> newest 3 remain, new dump among them
{
  d="$WORKDIR/e"; mkdir -p "$d"
  for i in 1 2 3 4 5; do make_old "$d" "deploy-panel-2020010${i}_000000.dump" "20260101000$i"; done
  run_backup "$d" KEEP_FILES=3 KEEP_DAYS=36500
  if [ "$rc" -eq 0 ] && [ "$(count_dumps "$d")" = 3 ] && [ ! -e "$d/deploy-panel-20200101_000000.dump" ] \
    && [ ! -e "$d/deploy-panel-20200102_000000.dump" ] && [ ! -e "$d/deploy-panel-20200103_000000.dump" ] \
    && [ -e "$d/deploy-panel-20200105_000000.dump" ] && [ -e "$d/deploy-panel-20200104_000000.dump" ]; then
    pass "(e) KEEP_FILES alone: rotation by count keeps the newest KEEP_FILES"
  else
    fail "(e) rotation by count: rc=$rc left=$(count_dumps "$d")"
  fi
}

# (f) rotation, KEEP_DAYS alone: old dumps removed, the fresh one kept
{
  d="$WORKDIR/f"; mkdir -p "$d"
  make_old "$d" deploy-panel-20200101_000000.dump 202001010000
  run_backup "$d" KEEP_FILES=50 KEEP_DAYS=2
  if [ "$rc" -eq 0 ] && [ ! -e "$d/deploy-panel-20200101_000000.dump" ] && [ "$(count_dumps "$d")" = 1 ]; then
    pass "(f) KEEP_DAYS alone: rotation by age removes dumps older than KEEP_DAYS"
  else
    fail "(f) rotation by age: rc=$rc files=$(count_dumps "$d")"
  fi
}

# (f1) both set: the stricter rule wins. One 2020 dump and four from today; KEEP_FILES=3
#      leaves 3 (count is stricter than age here), KEEP_DAYS=1 with KEEP_FILES=50 leaves 5
{
  d="$WORKDIR/f1"; mkdir -p "$d"
  make_old "$d" deploy-panel-20200101_000000.dump 202001010000
  today="$(date +%Y%m%d)"
  for i in 1 2 3 4; do make_old "$d" "deploy-panel-recent_0$i.dump" "${today}000$i"; done
  run_backup "$d" KEEP_FILES=3 KEEP_DAYS=2
  r1=$rc; left1="$(count_dumps "$d")"; old1=0; [ -e "$d/deploy-panel-20200101_000000.dump" ] && old1=1
  d="$WORKDIR/f1b"; mkdir -p "$d"
  make_old "$d" deploy-panel-20200101_000000.dump 202001010000
  for i in 1 2 3 4; do make_old "$d" "deploy-panel-recent_0$i.dump" "${today}000$i"; done
  run_backup "$d" KEEP_FILES=50 KEEP_DAYS=2
  r2=$rc; left2="$(count_dumps "$d")"
  if [ "$r1" = 0 ] && [ "$left1" = 3 ] && [ "$old1" = 0 ] && [ "$r2" = 0 ] && [ "$left2" = 5 ]; then
    pass "(f1) KEEP_FILES and KEEP_DAYS together: each rule applies, the stricter one decides"
  else
    fail "(f1) both rules: $r1 left=$left1 old=$old1 / $r2 left=$left2"
  fi
}

# (f2) a failed run does not rotate
{
  d="$WORKDIR/f2"; mkdir -p "$d"
  make_old "$d" deploy-panel-20200101_000000.dump 202001010000
  run_backup "$d" FAKE_MODE=cut_off KEEP_FILES=1 KEEP_DAYS=1
  if [ "$rc" -eq 1 ] && [ -e "$d/deploy-panel-20200101_000000.dump" ]; then
    pass "(f2) failed run leaves older dumps alone"
  else
    fail "(f2) failed run rotated: rc=$rc"
  fi
}

# (g) hook set and working: called once with the dump path
{
  d="$WORKDIR/g"
  hook="$WORKDIR/hook_ok.sh"
  printf '#!/bin/sh\necho "$@" >> "%s/hook_args"\n' "$WORKDIR" > "$hook"; chmod +x "$hook"
  run_backup "$d" BACKUP_OFFHOST_HOOK="$hook"
  f="$(find "$d" -maxdepth 1 -name 'deploy-panel-*.dump' | head -1)"
  if [ "$rc" -eq 0 ] && [ "$(cat "$WORKDIR/hook_args")" = "$f" ]; then
    pass "(g) off-host hook receives the dump path, exactly once"
  else
    fail "(g) hook success: rc=$rc args=$(cat "$WORKDIR/hook_args" 2>/dev/null)"
  fi
}

# (g2) hook empty or unset: no hook runs, the run succeeds
{
  d="$WORKDIR/g2"
  rm -f "$WORKDIR/hook_args"
  run_backup "$d" BACKUP_OFFHOST_HOOK=; r1=$rc
  run_backup "$d"; r2=$rc
  if [ "$r1" = 0 ] && [ "$r2" = 0 ] && [ ! -e "$WORKDIR/hook_args" ] && ! grep -q "off-host" <<< "$out_text"; then
    pass "(g2) empty and unset BACKUP_OFFHOST_HOOK both mean no hook"
  else
    fail "(g2) hook empty/unset: $r1 $r2"
  fi
}

# (h) hook failure: exit 3, dump kept, rotation skipped
{
  d="$WORKDIR/h"; mkdir -p "$d"
  make_old "$d" deploy-panel-20200101_000000.dump 202001010000
  hook="$WORKDIR/hook_fail.sh"
  printf '#!/bin/sh\nexit 7\n' > "$hook"; chmod +x "$hook"
  run_backup "$d" BACKUP_OFFHOST_HOOK="$hook" KEEP_FILES=1 KEEP_DAYS=1
  if [ "$rc" -eq 3 ] && [ "$(count_dumps "$d")" = 2 ] && [ -e "$d/deploy-panel-20200101_000000.dump" ] \
    && grep -q "off-host hook failed" <<< "$out_text"; then
    pass "(h) hook failure -> exit 3, dump kept, rotation skipped"
  else
    fail "(h) hook failure: rc=$rc files=$(count_dumps "$d")"
  fi
}

# (i) hook configured but not an executable file -> exit 2 before any docker call
{
  d="$WORKDIR/i"
  : > "$WORKDIR/not_exec.sh"
  run_backup "$d" BACKUP_OFFHOST_HOOK="$WORKDIR/not_exec.sh"; r1=$rc; u1=0; [ -s "$FAKE_DOCKER_LOG" ] && u1=1
  run_backup "$d" BACKUP_OFFHOST_HOOK="$WORKDIR/missing_hook.sh"; r2=$rc; u2=0; [ -s "$FAKE_DOCKER_LOG" ] && u2=1
  if [ "$r1" = 2 ] && [ "$u1" = 0 ] && [ "$r2" = 2 ] && [ "$u2" = 0 ]; then
    pass "(i) non-executable or missing hook -> exit 2 before docker"
  else
    fail "(i) bad hook: $r1 $u1 $r2 $u2"
  fi
}

# (j) bad configuration: compose file missing, non-numeric / zero KEEP_*
{
  d="$WORKDIR/j"
  run_backup "$d" BACKUP_COMPOSE_FILE="$WORKDIR/missing.yml"; r1=$rc
  run_backup "$d" KEEP_FILES=abc; r2=$rc
  run_backup "$d" KEEP_DAYS=0; r3=$rc
  run_backup "$d" KEEP_FILES=0; r4=$rc
  if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ] && [ "$r4" = 2 ] && [ ! -d "$d" ]; then
    pass "(j) bad configuration -> exit 2, nothing written"
  else
    fail "(j) bad configuration: $r1 $r2 $r3 $r4"
  fi
}

# (j2) an empty KEEP_FILES / KEEP_DAYS is the same as unset: the default (14) applies
{
  d="$WORKDIR/j2"; mkdir -p "$d"
  for i in $(seq 1 16); do
    n="$(printf '%02d' "$i")"
    make_old "$d" "deploy-panel-202001${n}_000000.dump" "$(date +%Y%m%d)00$n"
  done
  run_backup "$d" KEEP_FILES= KEEP_DAYS=; r1=$rc; l1="$(count_dumps "$d")"
  # unset behaves the same as empty
  d="$WORKDIR/j2b"; mkdir -p "$d"
  for i in $(seq 1 16); do
    n="$(printf '%02d' "$i")"
    make_old "$d" "deploy-panel-202001${n}_000000.dump" "$(date +%Y%m%d)00$n"
  done
  run_backup "$d"; r2=$rc; l2="$(count_dumps "$d")"
  if [ "$r1" = 0 ] && [ "$l1" = 14 ] && [ "$r2" = 0 ] && [ "$l2" = 14 ]; then
    pass "(j2) empty and unset KEEP_FILES/KEEP_DAYS both fall back to 14"
  else
    fail "(j2) default KEEP_*: $r1 left=$l1 / $r2 left=$l2"
  fi
}

# (k) stale temp files older than a day are reaped, fresh ones are not
{
  d="$WORKDIR/k"; mkdir -p "$d"
  : > "$d/.deploy-panel-old.1.dump.tmp"; touch -t 202001010000 "$d/.deploy-panel-old.1.dump.tmp"
  : > "$d/.deploy-panel-new.2.dump.tmp"
  run_backup "$d"
  if [ "$rc" -eq 0 ] && [ ! -e "$d/.deploy-panel-old.1.dump.tmp" ] && [ -e "$d/.deploy-panel-new.2.dump.tmp" ]; then
    pass "(k) stale temp files are reaped"
  else
    fail "(k) stale temp files: rc=$rc"
  fi
}

# (l) BACKUP_SKIP_ROTATION: the dump is written, nothing is rotated away
{
  d="$WORKDIR/l"; mkdir -p "$d"
  for i in 1 2 3; do make_old "$d" "deploy-panel-2020010${i}_000000.dump" "20200101000$i"; done
  run_backup "$d" KEEP_FILES=1 KEEP_DAYS=1 BACKUP_SKIP_ROTATION=1
  if [ "$rc" -eq 0 ] && [ "$(count_dumps "$d")" = 4 ]; then
    pass "(l) BACKUP_SKIP_ROTATION keeps every dump"
  else
    fail "(l) skip rotation: rc=$rc files=$(count_dumps "$d")"
  fi
}

# (m) two runs in the same second do not overwrite each other
{
  d="$WORKDIR/m"
  run_backup "$d" FAKE_DATE=20300101_000000; r1=$rc
  run_backup "$d" FAKE_DATE=20300101_000000; r2=$rc
  if [ "$r1" = 0 ] && [ "$r2" = 0 ] && [ "$(count_dumps "$d")" = 2 ] && [ -e "$d/deploy-panel-20300101_000000.dump" ]; then
    pass "(m) same-second runs keep both dumps"
  else
    fail "(m) same second: $r1 $r2 files=$(count_dumps "$d")"
  fi
}

# (n) BACKUP_DIR inside the checkout is refused wherever it is: exit 2 before docker,
#     nothing created; a directory outside the checkout is fine
{
  stray="$REPO/.backup-test-stray-$$"
  run_backup "$stray"; r1=$rc; created=0; [ -e "$stray" ] && created=1; docker_used=0; [ -s "$FAKE_DOCKER_LOG" ] && docker_used=1
  run_backup "$REPO/backups"; r2=$rc
  run_backup "$REPO/backups/../.backup-test-stray-$$"; r3=$rc
  run_backup "$REPO/.backup-test-stray-$$/deeper"; r4=$rc
  run_backup "$REPO"; r5=$rc
  link="$WORKDIR/link_into_repo"; ln -s "$REPO" "$link"
  run_backup "$link/.backup-test-stray-$$"; r6=$rc
  # relative path: resolved against the working directory, here the checkout
  r8=0; (cd "$REPO" && env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR=".backup-test-stray-$$" "$BACKUP_SCRIPT" > /dev/null 2>&1) || r8=$?
  leaked=0; [ -e "$stray" ] || [ -e "$REPO/backups" ] && leaked=1
  rm -rf "$stray"
  run_backup "$WORKDIR/outside"; r9=$rc
  if [ "$r1" = 2 ] && [ "$created" = 0 ] && [ "$docker_used" = 0 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ] && [ "$r4" = 2 ] \
    && [ "$r5" = 2 ] && [ "$r6" = 2 ] && [ "$r8" = 2 ] && [ "$leaked" = 0 ] && [ "$r9" = 0 ]; then
    pass "(n) BACKUP_DIR inside the checkout (also backups/, the root, via symlink, relative) is refused"
  else
    fail "(n) BACKUP_DIR in checkout: $r1 created=$created docker=$docker_used $r2 $r3 $r4 $r5 $r6 rel=$r8 leaked=$leaked outside=$r9"
  fi
}

# (o) BACKUP_DIR precedence: set wins over the HOME default; empty and unset both mean
#     $HOME/deploy-panel-backups (created 700)
{
  explicit="$WORKDIR/o_explicit"
  def="$HOME/deploy-panel-backups"
  rm -rf "$def"
  run_backup "$explicit"; r1=$rc; e1="$(count_dumps "$explicit")"; d1="$(count_dumps "$def")"
  run_backup "" ; r2=$rc; d2="$(count_dumps "$def")"
  rm -rf "$def"
  run_backup_raw; r3=$rc; d3="$(count_dumps "$def")"
  mode_def="$(stat -c %a "$def" 2>/dev/null || stat -f %Lp "$def")"
  if [ "$r1" = 0 ] && [ "$e1" = 1 ] && [ "$d1" = 0 ] && [ "$r2" = 0 ] && [ "$d2" = 1 ] \
    && [ "$r3" = 0 ] && [ "$d3" = 1 ] && [ "$mode_def" = 700 ]; then
    pass "(o) BACKUP_DIR set wins; empty and unset use \$HOME/deploy-panel-backups (mode 700)"
  else
    fail "(o) BACKUP_DIR defaults: $r1 explicit=$e1 default=$d1 / empty: $r2 $d2 / unset: $r3 $d3 mode=$mode_def"
  fi
}

# (p) no HOME and no BACKUP_DIR -> exit 2; an explicit BACKUP_DIR needs no HOME
{
  d="$WORKDIR/p"
  : > "$FAKE_DOCKER_LOG"; rc=0
  out_text="$(env -u HOME PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" "$BACKUP_SCRIPT" 2>&1)" || rc=$?
  r1=$rc; u1=0; [ -s "$FAKE_DOCKER_LOG" ] && u1=1
  rc=0
  out_text="$(env -u HOME PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$d" "$BACKUP_SCRIPT" 2>&1)" || rc=$?
  if [ "$r1" = 2 ] && [ "$u1" = 0 ] && [ "$rc" = 0 ] && [ "$(count_dumps "$d")" = 1 ]; then
    pass "(p) HOME unset: refused without BACKUP_DIR, fine with it"
  else
    fail "(p) HOME unset: $r1 docker=$u1 / with dir: $rc"
  fi
}

# (q) the development stack file is refused before any docker call; so is the checkout's
#     docker-compose.yml given by a relative or symlinked path
{
  d="$WORKDIR/q"
  run_backup "$d" BACKUP_COMPOSE_FILE="$REPO/docker-compose.yml"; r1=$rc; u1=0; [ -s "$FAKE_DOCKER_LOG" ] && u1=1
  run_backup "$d" BACKUP_COMPOSE_FILE="$REPO/scripts/../docker-compose.yml"; r2=$rc
  ln -sfn "$REPO" "$WORKDIR/repo_link"
  run_backup "$d" BACKUP_COMPOSE_FILE="$WORKDIR/repo_link/docker-compose.yml"; r3=$rc
  ln -sf "$REPO/docker-compose.yml" "$WORKDIR/compose_symlink.yml"
  run_backup "$d" BACKUP_COMPOSE_FILE="$WORKDIR/compose_symlink.yml"; r4=$rc
  ln -f "$REPO/docker-compose.yml" "$REPO/.hardlink-compose.yml" || r5=ln-failed
  [ -n "${r5:-}" ] || { run_backup "$d" BACKUP_COMPOSE_FILE="$REPO/.hardlink-compose.yml"; r5=$rc; }
  rm -f "$REPO/.hardlink-compose.yml"
  if [ "$r1" = 2 ] && [ "$u1" = 0 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ] && [ "$r4" = 2 ] && [ "$r5" = 2 ] && grep -q "development stack" <<< "$out_text" && [ ! -d "$d" ]; then
    pass "(q) docker-compose.yml (the dev stack) is refused, also via .. , a symlink to the directory, a file symlink and a hardlink"
  else
    fail "(q) dev stack file: $r1 docker=$u1 $r2 $r3 file-symlink=$r4 hardlink=$r5"
  fi
}

echo "backup tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
