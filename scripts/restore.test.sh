#!/usr/bin/env bash
# Test driver for scripts/restore.sh with a fake `docker` on PATH.
#   bash scripts/restore.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTORE_SCRIPT="$SCRIPT_DIR/restore.sh"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# The cases below set every input explicitly; nothing may leak in from the caller.
unset BACKUP_DIR BACKUP_COMPOSE_FILE BACKUP_DB_SERVICE BACKUP_SKIP_ROTATION BACKUP_OFFHOST_HOOK KEEP_FILES KEEP_DAYS PG_USER PG_DB RESTORE_APP_SERVICE

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"; rm -f "$REPO/.hardlink-compose.yml"' EXIT
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
export HOME="$WORKDIR/home"
mkdir -p "$HOME"

export FAKE_DOCKER_LOG="$WORKDIR/docker.log"
export FAKE_PSQL_STDIN="$WORKDIR/psql_stdin"
# restore.sh keeps its private SQL copy here; the tests check it is gone afterwards
TMPD="$WORKDIR/tmp"
mkdir -p "$TMPD"
COMPOSE_FILE="$WORKDIR/compose.yml"
: > "$COMPOSE_FILE"
BACKUPS="$WORKDIR/backups"

fail_count=0
pass_count=0
pass() { pass_count=$((pass_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); echo "FAIL: $1"; }

# The archive the fake pg_restore accepts (it must end with the end-of-archive line, the
# way the real one rejects a cut-off archive) and the SQL it converts to.
{
  printf 'FAKEPGDMP header\n'
  for i in $(seq 1 200); do printf 'table data row %d\n' "$i"; done
  printf 'FAKE-ARCHIVE-END\n'
} > "$WORKDIR/good.dump"
DUMP="$WORKDIR/good.dump"
SQL="$WORKDIR/converted.sql"
{
  printf -- '-- PostgreSQL database dump\n'
  for i in $(seq 1 50); do printf 'INSERT INTO t VALUES (%d);\n' "$i"; done
  printf -- '-- PostgreSQL database dump complete\n'
} > "$SQL"

# Fake docker. FAKE_RUNNING lists the running services. `exec ... pg_restore -f -` is the
# conversion (FAKE_CONVERT_MODE: good, nomarker, txn:<statement>); `pg_restore -f /dev/null`
# is backup.sh's validation of the pre-restore dump.
cat > "$FAKE_BIN/docker" <<EOF2
#!/usr/bin/env bash
echo "\$*" >> "\$FAKE_DOCKER_LOG"
case "\$*" in
  # like real compose: "ps -q" lists running containers only, "ps -a -q" all of them
  *" ps -a -q "*) [ "\${FAKE_NO_CONTAINER:-0}" = 1 ] && exit 0; echo fake-cid; exit 0 ;;
  *" ps -q "*)
    [ "\${FAKE_NO_CONTAINER:-0}" = 1 ] && exit 0
    case "\${FAKE_HEALTH:-running healthy}" in exited* | dead*) exit 0 ;; esac
    echo fake-cid; exit 0 ;;
  *"inspect "*)
    # FAKE_HEALTH: "<state> <health>" (the restart count, always 0, is appended);
    # FAKE_HEALTH_AFTER=n: the first n queries print "running starting 0", later ones FAKE_HEALTH;
    # FAKE_HEALTH_LIST="a;b;c": query n prints entry n (the last one repeats), each entry
    # "<state> <health> <restarts>"
    echo x >> "$WORKDIR/inspect_count"
    n="\$(wc -l < "$WORKDIR/inspect_count" | tr -d ' ')"
    if [ -n "\${FAKE_HEALTH_LIST:-}" ]; then
      IFS=';' read -r -a l <<< "\$FAKE_HEALTH_LIST"
      [ "\$n" -le "\${#l[@]}" ] || n=\${#l[@]}
      echo "\${l[\$((n - 1))]}"; exit 0
    fi
    if [ "\$n" -le "\${FAKE_HEALTH_AFTER:-0}" ]; then echo "running starting 0"; exit 0; fi
    echo "\${FAKE_HEALTH:-running healthy} 0"; exit 0 ;;
  *" ps "*) [ "\${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' \${FAKE_RUNNING:-backend db}; exit 0 ;;
  *" exec "*"pg_restore -f /dev/null"*) cat > /dev/null; exit 0 ;;
  *" exec "*"pg_restore -f -"*)
    cat > "$WORKDIR/convert_stdin"
    [ "\$(tail -n 1 "$WORKDIR/convert_stdin")" = "FAKE-ARCHIVE-END" ] || { echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1; }
    case "\${FAKE_CONVERT_MODE:-good}" in
      good) cat "$SQL" ;;
      nomarker) grep -v 'database dump complete' "$SQL" ;;
      txn:*) m="\${FAKE_CONVERT_MODE#txn:}"; awk -v s="\$m" '/^-- PostgreSQL database dump complete/ { print s } { print }' "$SQL" ;;
    esac
    exit 0 ;;
  *" exec "*pg_dump*)
    [ "\${FAKE_PGDUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: fatal error" >&2; exit 1; }
    # FAKE_PGDUMP_SLEEP: seconds the pre-restore dump takes
    [ -z "\${FAKE_PGDUMP_SLEEP:-}" ] || sleep "\$FAKE_PGDUMP_SLEEP"
    cat "$DUMP"; exit 0 ;;
  *" exec "*psql*)
    cat > "\$FAKE_PSQL_STDIN"
    # FAKE_PSQL_SLEEP: seconds psql keeps running after reading its input
    [ -z "\${FAKE_PSQL_SLEEP:-}" ] || sleep "\$FAKE_PSQL_SLEEP"
    [ "\${FAKE_PSQL_FAIL:-0}" = 1 ] && { echo "psql: ERROR" >&2; exit 3; }
    exit 0 ;;
  *" stop "*)
    # FAKE_STOP_SLEEP: seconds the stop takes (the grace period)
    [ -z "\${FAKE_STOP_SLEEP:-}" ] || sleep "\$FAKE_STOP_SLEEP"
    # FAKE_STOP_RM: files (glob allowed) that disappear while the backend is being stopped
    # shellcheck disable=SC2086
    [ -z "\${FAKE_STOP_RM:-}" ] || rm -f \$FAKE_STOP_RM
    [ "\${FAKE_STOP_FAIL:-0}" = 1 ] && { echo "stop: error" >&2; exit 5; }; exit 0 ;;
  *" start "*) [ "\${FAKE_START_FAIL:-0}" = 1 ] && { echo "start: error" >&2; exit 5; }; exit 0 ;;
  *) echo "fake docker: unexpected call: \$*" >&2; exit 9 ;;
esac
EOF2
chmod +x "$FAKE_BIN/docker"

# run_restore [VAR=value ...] -- args...; sets rc, out_text
run_restore() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : > "$FAKE_DOCKER_LOG"; rm -f "$FAKE_PSQL_STDIN" "$WORKDIR/inspect_count"; rm -rf "$BACKUPS"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" TMPDIR="$TMPD" ${envs[@]+"${envs[@]}"} "$RESTORE_SCRIPT" "$@" 2>&1)" || rc=$?
}
no_db_calls() { ! grep -q -E ' (exec|stop|start|run) ' "$FAKE_DOCKER_LOG"; }
no_changing_calls() { ! grep -q -E ' (stop|start|run) |psql|pg_dump' "$FAKE_DOCKER_LOG"; }
line_of() { grep -n -- "$1" "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1 || true; }
count_dumps() { { find "$BACKUPS" -maxdepth 1 -name 'deploy-panel-*.dump' 2>/dev/null || true; } | wc -l | tr -d ' '; }
# the stdin psql saw must be BEGIN, the schema reset, the SQL byte for byte, then COMMIT
stdin_is_reset_plus_sql() {
  local n; n="$(wc -l < "$SQL" | tr -d ' ')"
  [ "$(sed -n 1p "$FAKE_PSQL_STDIN")" = "BEGIN;" ] \
    && [ "$(sed -n 3p "$FAKE_PSQL_STDIN")" = "DROP SCHEMA public CASCADE;" ] \
    && grep -q '^CREATE SCHEMA public AUTHORIZATION pg_database_owner;$' "$FAKE_PSQL_STDIN" \
    && grep -q '^GRANT USAGE ON SCHEMA public TO PUBLIC;$' "$FAKE_PSQL_STDIN" \
    && sed -n "7,$((6 + n))p" "$FAKE_PSQL_STDIN" | cmp -s - "$SQL" \
    && [ "$(tail -n 1 "$FAKE_PSQL_STDIN")" = "COMMIT;" ] \
    && [ "$(wc -l < "$FAKE_PSQL_STDIN" | tr -d ' ')" = "$((7 + n))" ]
}
no_tmp_left() { [ -z "$(find "$TMPD" -mindepth 1 2>/dev/null)" ]; }

# (a) success: convert, stop backend, pre-restore dump, reset + SQL in one transaction, start backend
{
  run_restore -- --yes "$DUMP"
  l_conv="$(line_of 'pg_restore -f -')"; l_stop="$(line_of ' stop backend')"; l_dump="$(line_of ' pg_dump ')"
  l_psql="$(line_of 'psql -v ON_ERROR_STOP=1')"; l_start="$(line_of ' start backend')"
  if [ "$rc" -eq 0 ] && stdin_is_reset_plus_sql \
    && grep -q "exec -T db psql -v ON_ERROR_STOP=1 -q -U deploy_panel -d deploy_panel" "$FAKE_DOCKER_LOG" \
    && ! grep -q -- "--single-transaction" "$FAKE_DOCKER_LOG" && ! grep -q -- "--accept-data-loss" "$FAKE_DOCKER_LOG" && no_tmp_left \
    && [ "$l_conv" -lt "$l_stop" ] && [ "$l_stop" -lt "$l_dump" ] && [ "$l_dump" -lt "$l_psql" ] && [ "$l_psql" -lt "$l_start" ] \
    && [ "$(count_dumps)" = 1 ]; then
    pass "(a) success: convert, stop backend, pre-backup, reset + SQL, start backend, in that order"
  else
    fail "(a) success: rc=$rc order=$l_conv,$l_stop,$l_dump,$l_psql,$l_start dumps=$(count_dumps)"
  fi
}

# (a1) every docker call acts on the given compose file and nothing else (never the dev stack);
# the one exception is the health query, which names the container id that `compose ps -q`
# of that file returned
{
  run_restore -- --yes "$DUMP"
  if [ "$rc" -eq 0 ] && [ -s "$FAKE_DOCKER_LOG" ] && ! grep -v "^inspect -f .* fake-cid$" "$FAKE_DOCKER_LOG" | grep -v -q "^compose -f $COMPOSE_FILE "; then
    pass "(a1) every docker call carries the production compose file"
  else
    fail "(a1) compose file on every call: rc=$rc"
  fi
}

# (a2) --no-pre-backup: no pg_dump call, no backup directory
{
  run_restore -- --yes --no-pre-backup "$DUMP"
  if [ "$rc" -eq 0 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG" && [ ! -e "$BACKUPS" ] && stdin_is_reset_plus_sql; then
    pass "(a2) --no-pre-backup skips the pre-restore dump"
  else
    fail "(a2) no pre-backup: rc=$rc"
  fi
}

# (a3) PG_USER / PG_DB reach psql and the pre-restore dump
{
  run_restore PG_USER=other_user PG_DB=other_db -- --yes "$DUMP"
  if [ "$rc" -eq 0 ] && grep -q "psql -v ON_ERROR_STOP=1 -q -U other_user -d other_db" "$FAKE_DOCKER_LOG" \
    && grep -q "pg_dump -Fc -U other_user other_db" "$FAKE_DOCKER_LOG"; then
    pass "(a3) PG_USER / PG_DB override the defaults in psql and the pre-restore dump"
  else
    fail "(a3) PG_USER/PG_DB: rc=$rc"
  fi
}

# (b) flag order does not matter
{
  run_restore -- "$DUMP" --yes
  if [ "$rc" -eq 0 ] && stdin_is_reset_plus_sql; then pass "(b) --yes after the file works"; else fail "(b) flag order: rc=$rc"; fi
}

# (c) no confirmation -> exit 2, no docker call at all
{
  run_restore -- "$DUMP"
  if [ "$rc" -eq 2 ] && [ ! -s "$FAKE_DOCKER_LOG" ] && [ ! -e "$FAKE_PSQL_STDIN" ] && grep -q -- "--yes" <<< "$out_text" && grep -q -- "$COMPOSE_FILE" <<< "$out_text"; then
    pass "(c) without --yes: refused, names the compose file, database untouched"
  else
    fail "(c) no confirmation: rc=$rc"
  fi
}

# (d) no file argument (with and without --yes) -> exit 2
{
  run_restore -- ; r1=$rc; n1=0; no_db_calls || n1=1
  run_restore -- --yes; r2=$rc; n2=0; no_db_calls || n2=1
  if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$n1" = 0 ] && [ "$n2" = 0 ]; then
    pass "(d) no file argument -> exit 2"
  else
    fail "(d) no file: $r1 $r2 $n1 $n2"
  fi
}

# (e) missing file -> exit 2
{
  run_restore -- --yes "$WORKDIR/nope.dump"
  if [ "$rc" -eq 2 ] && no_db_calls && grep -q "not found" <<< "$out_text"; then pass "(e) missing file -> exit 2"; else fail "(e) missing file: rc=$rc"; fi
}

# (f) unknown option and two files -> exit 2
{
  run_restore -- --yes --force "$DUMP"; r1=$rc
  run_restore -- --yes "$DUMP" "$DUMP"; r2=$rc
  if [ "$r1" = 2 ] && [ "$r2" = 2 ]; then pass "(f) unknown option / two files -> exit 2"; else fail "(f) args: $r1 $r2"; fi
}

# (g) invalid dumps -> exit 1, backend and database untouched: a file below the size floor, a
#     big file that pg_restore cannot read (cut off / not an archive)
{
  printf 'x\n' > "$WORKDIR/tiny.dump"
  head -c 1500 "$DUMP" > "$WORKDIR/cutoff.dump"
  { printf 'not an archive\n'; for i in $(seq 1 300); do printf 'line %d\n' "$i"; done; } > "$WORKDIR/garbage.dump"
  run_restore -- --yes "$WORKDIR/tiny.dump"; r1=$rc; n1=0; no_db_calls || n1=1
  run_restore -- --yes "$WORKDIR/cutoff.dump"; r2=$rc; n2=0; no_changing_calls || n2=1; m2=0; { no_tmp_left && grep -q "could not be read as a custom-format dump" <<< "$out_text"; } || m2=1
  run_restore -- --yes "$WORKDIR/garbage.dump"; r3=$rc; n3=0; no_changing_calls || n3=1; m3=0; grep -q "could not be read as a custom-format dump" <<< "$out_text" || m3=1
  if [ "$r1" = 1 ] && [ "$r2" = 1 ] && [ "$r3" = 1 ] && [ "$n1$n2$n3$m2$m3" = 00000 ]; then
    pass "(g) invalid dump (tiny, cut off, not an archive) -> exit 1 before changing anything"
  else
    fail "(g) invalid dump: $r1 $r2 $r3 $n1 $n2 $n3 $m2 $m3"
  fi
}

# (h) db not running -> exit 2, backend not stopped
{
  run_restore FAKE_RUNNING=backend -- --yes "$DUMP"
  if [ "$rc" -eq 2 ] && no_changing_calls && ! grep -q 'pg_restore' "$FAKE_DOCKER_LOG"; then pass "(h) db not running -> exit 2, backend untouched"; else fail "(h) db not running: rc=$rc"; fi
}

# (i) psql fails -> exit 1, backend stays stopped and the message says so
{
  run_restore FAKE_PSQL_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && ! grep -q ' start backend' "$FAKE_DOCKER_LOG" && ! grep -q ' run ' "$FAKE_DOCKER_LOG" \
    && grep -q "still stopped" <<< "$out_text" && grep -q "start backend" <<< "$out_text" && no_tmp_left; then
    pass "(i) psql failure -> exit 1, backend left stopped"
  else
    fail "(i) psql failure: rc=$rc"
  fi
}

# (j) backend not running: no stop, no start, the restore itself still runs
{
  run_restore FAKE_RUNNING=db -- --yes "$DUMP"
  if [ "$rc" -eq 0 ] && ! grep -q -E ' (stop|start) ' "$FAKE_DOCKER_LOG" && stdin_is_reset_plus_sql; then pass "(j) backend not running: not stopped, not started"; else fail "(j) backend not running: rc=$rc"; fi
}

# (k) RESTORE_APP_SERVICE: unset = backend, empty = left alone even when running, a name = that service
{
  run_restore -- --yes "$DUMP"; r0=$rc; s0=0; grep -q ' stop backend' "$FAKE_DOCKER_LOG" && grep -q ' start backend' "$FAKE_DOCKER_LOG" && s0=1
  run_restore RESTORE_APP_SERVICE= -- --yes "$DUMP"; r1=$rc; s1=0; grep -q -E ' (stop|start) ' "$FAKE_DOCKER_LOG" && s1=1
  run_restore RESTORE_APP_SERVICE=web FAKE_RUNNING="web db" -- --yes "$DUMP"; r2=$rc; s2=0; grep -q ' stop web' "$FAKE_DOCKER_LOG" && grep -q ' start web' "$FAKE_DOCKER_LOG" && s2=1
  if [ "$r0" = 0 ] && [ "$s0" = 1 ] && [ "$r1" = 0 ] && [ "$s1" = 0 ] && [ "$r2" = 0 ] && [ "$s2" = 1 ]; then
    pass "(k) RESTORE_APP_SERVICE: default backend, empty skips, a name is honoured"
  else
    fail "(k) RESTORE_APP_SERVICE: $r0 $s0 $r1 $s1 $r2 $s2"
  fi
}

# (l) compose ps failure and missing compose file -> exit 2
{
  run_restore FAKE_PS_FAIL=1 -- --yes "$DUMP"; r1=$rc
  run_restore BACKUP_COMPOSE_FILE="$WORKDIR/missing.yml" -- --yes "$DUMP"; r2=$rc
  if [ "$r1" = 2 ] && [ "$r2" = 2 ]; then pass "(l) compose ps failure / missing compose file -> exit 2"; else fail "(l) compose: $r1 $r2"; fi
}

# (l2) the development stack file is refused before any docker call, also via .. and a symlink
{
  run_restore BACKUP_COMPOSE_FILE="$REPO/docker-compose.yml" -- --yes "$DUMP"; r1=$rc; u1=0; [ -s "$FAKE_DOCKER_LOG" ] && u1=1
  run_restore BACKUP_COMPOSE_FILE="$REPO/scripts/../docker-compose.yml" -- --yes "$DUMP"; r2=$rc
  ln -sfn "$REPO" "$WORKDIR/repo_link"
  run_restore BACKUP_COMPOSE_FILE="$WORKDIR/repo_link/docker-compose.yml" -- --yes "$DUMP"; r3=$rc
  ln -sf "$REPO/docker-compose.yml" "$WORKDIR/compose_symlink.yml"
  run_restore BACKUP_COMPOSE_FILE="$WORKDIR/compose_symlink.yml" -- --yes "$DUMP"; r4=$rc
  ln -f "$REPO/docker-compose.yml" "$REPO/.hardlink-compose.yml" || r5=ln-failed
  [ -n "${r5:-}" ] || { run_restore BACKUP_COMPOSE_FILE="$REPO/.hardlink-compose.yml" -- --yes "$DUMP"; r5=$rc; }
  rm -f "$REPO/.hardlink-compose.yml"
  if [ "$r1" = 2 ] && [ "$u1" = 0 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ] && [ "$r4" = 2 ] && [ "$r5" = 2 ] && grep -q "development stack" <<< "$out_text"; then
    pass "(l2) docker-compose.yml (the dev stack) is refused, also via .. , a symlink to the directory, a file symlink and a hardlink"
  else
    fail "(l2) dev stack file: $r1 docker=$u1 $r2 $r3 file-symlink=$r4 hardlink=$r5"
  fi
}

# (m) the pre-restore backup fails: exit 3, nothing restored, the stopped backend is started again
{
  run_restore FAKE_PGDUMP_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 3 ] && [ ! -e "$FAKE_PSQL_STDIN" ] && ! grep -q 'psql' "$FAKE_DOCKER_LOG" && ! grep -q ' run ' "$FAKE_DOCKER_LOG" \
    && [ "$(line_of ' stop backend')" -lt "$(line_of ' start backend')" ] && grep -q -- "--no-pre-backup" <<< "$out_text"; then
    pass "(m) failed pre-restore backup -> exit 3, nothing changed, backend started again"
  else
    fail "(m) pre-backup failure: rc=$rc"
  fi
}

# (m2) the pre-restore backup fails and the backend cannot be restarted either: still exit 3, hint printed
{
  run_restore FAKE_PGDUMP_FAIL=1 FAKE_START_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 3 ] && grep -q "could not start backend" <<< "$out_text"; then pass "(m2) pre-backup failure and start failure -> exit 3 with the start command"; else fail "(m2): rc=$rc"; fi
}

# (n) the pre-restore dump never rotates: the oldest dump, restored with KEEP_FILES=1, survives
{
  rm -rf "$BACKUPS"; rm -f "$FAKE_PSQL_STDIN"
  mkdir -p "$BACKUPS"; cp "$DUMP" "$BACKUPS/deploy-panel-20200101_000000.dump"; touch -t 202001010000 "$BACKUPS/deploy-panel-20200101_000000.dump"
  : > "$FAKE_DOCKER_LOG"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" KEEP_FILES=1 KEEP_DAYS=1 "$RESTORE_SCRIPT" --yes "$BACKUPS/deploy-panel-20200101_000000.dump" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -e "$BACKUPS/deploy-panel-20200101_000000.dump" ] && [ "$(count_dumps)" = 2 ]; then
    pass "(n) pre-restore dump skips rotation, the file being restored survives"
  else
    fail "(n) rotation: rc=$rc dumps=$(count_dumps)"
  fi
}

# (o) docker compose stop fails: exit 1 before any change, no dump, no restore
{
  run_restore FAKE_STOP_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && ! grep -q -E 'pg_dump|psql| run | start ' "$FAKE_DOCKER_LOG" && grep -q "could not stop backend" <<< "$out_text"; then
    pass "(o) stop failure -> exit 1, nothing changed"
  else
    fail "(o) stop failure: rc=$rc"
  fi
}

# (p) the backend does not start after a good restore: exit 4 and the command to run
{
  run_restore FAKE_START_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 4 ] && stdin_is_reset_plus_sql && grep -q "did not start" <<< "$out_text" && grep -q "start backend" <<< "$out_text"; then
    pass "(p) start failure after restore -> exit 4 with the start command"
  else
    fail "(p) start failure: rc=$rc"
  fi
}

# (p2) the backend starts but is not healthy afterwards: exit 4, data restored and committed,
# the backend neither stopped nor started again by the script, logs and start commands printed
{
  bad=""
  # the reason is named at once, not after the timeout as "no container": plain `compose ps -q`
  # does not list a stopped container, so the script must ask with -a
  for h in "running unhealthy" "exited none" "exited unhealthy" "dead none"; do
    why="${h%% *}"; [ "$why" != running ] || why=unhealthy
    run_restore "FAKE_HEALTH=$h" RESTORE_WAIT_SECONDS=30 RESTORE_WAIT_POLL=0.01 -- --yes "$DUMP"
    { [ "$rc" -eq 4 ] && stdin_is_reset_plus_sql && grep -q "restored and committed, but backend is not healthy ($why)" <<< "$out_text" \
      && grep -q "logs --tail 100 backend" <<< "$out_text" && grep -q "start backend" <<< "$out_text" \
      && ! grep -q "backend healthy" <<< "$out_text" && ! grep -q "^restore: done" <<< "$out_text" \
      && [ "$(grep -c ' stop backend' "$FAKE_DOCKER_LOG")" = 1 ]; } || bad="$bad [$h rc=$rc]"
  done
  if [ -z "$bad" ]; then pass "(p2) unhealthy / exited / dead backend after the restore -> exit 4, committed, logs and start commands printed"; else fail "(p2) unhealthy backend:$bad"; fi
}

# (p3) the backend stays in "starting" (crash loop) until the wait runs out: exit 4
{
  run_restore FAKE_HEALTH="running starting" RESTORE_WAIT_SECONDS=2 RESTORE_WAIT_POLL=0.2 -- --yes "$DUMP"
  n="$(wc -l < "$WORKDIR/inspect_count" | tr -d ' ')"
  if [ "$rc" -eq 4 ] && grep -q "not healthy after 2s" <<< "$out_text" && [ "$n" -ge 2 ]; then
    pass "(p3) health wait times out -> exit 4 after polling ($n polls)"
  else
    fail "(p3) timeout: rc=$rc polls=$n out=$out_text"
  fi
  run_restore FAKE_HEALTH="running starting" FAKE_NO_CONTAINER=1 RESTORE_WAIT_SECONDS=0 RESTORE_WAIT_POLL=0.01 -- --yes "$DUMP"
  if [ "$rc" -eq 4 ] && grep -q "no container for backend" <<< "$out_text"; then pass "(p3b) no container to inspect -> exit 4"; else fail "(p3b) no container: rc=$rc"; fi
}

# (p4) the backend becomes healthy only after a few polls: exit 0, polled until then
{
  run_restore FAKE_HEALTH_AFTER=3 RESTORE_WAIT_POLL=0.01 -- --yes "$DUMP"
  n="$(wc -l < "$WORKDIR/inspect_count" | tr -d ' ')"
  l_start="$(line_of ' start backend')"; l_insp="$(line_of 'inspect ')"
  if [ "$rc" -eq 0 ] && [ "$n" = 5 ] && grep -q "restore: backend healthy" <<< "$out_text" && [ "$l_start" -lt "$l_insp" ]; then
    pass "(p4) success waits for health after the start: 3 polls starting, one healthy, one confirming"
  else
    fail "(p4) wait for health: rc=$rc polls=$n start=$l_start inspect=$l_insp"
  fi
}

# (p5) no healthcheck defined: exit 0 with a warning that only the start was confirmed
{
  run_restore FAKE_HEALTH="running none" -- --yes "$DUMP"
  if [ "$rc" -eq 0 ] && grep -q "has no healthcheck" <<< "$out_text" && ! grep -q "backend healthy" <<< "$out_text"; then
    pass "(p5) backend without a healthcheck -> exit 0 with a warning"
  else
    fail "(p5) no healthcheck: rc=$rc"
  fi
}

# (p6) RESTORE_WAIT_SECONDS / RESTORE_WAIT_POLL: each bad value alone refuses before any docker
# call; each good value alone (and both together) is accepted; empty counts as unset (the defaults apply)
{
  bad=""
  for e in RESTORE_WAIT_SECONDS=abc RESTORE_WAIT_SECONDS=-1 RESTORE_WAIT_SECONDS=1.5 RESTORE_WAIT_POLL=x RESTORE_WAIT_POLL=1.2.3 RESTORE_WAIT_POLL=0 RESTORE_WAIT_POLL=00 RESTORE_WAIT_POLL=0.0 RESTORE_WAIT_SECONDS=1234567890; do
    run_restore "$e" -- --yes "$DUMP"
    { [ "$rc" -eq 2 ] && no_db_calls; } || bad="$bad [$e rc=$rc]"
  done
  for e in RESTORE_WAIT_SECONDS=5 RESTORE_WAIT_POLL=0.5 "RESTORE_WAIT_SECONDS=5 RESTORE_WAIT_POLL=1" RESTORE_WAIT_SECONDS= RESTORE_WAIT_POLL= RESTORE_WAIT_SECONDS=08 RESTORE_WAIT_SECONDS=09 RESTORE_WAIT_SECONDS=010 "RESTORE_WAIT_SECONDS=08 RESTORE_WAIT_POLL=0.01"; do
    # a leading zero is decimal, not octal: 08 and 09 must not break the deadline arithmetic
    # after the COMMIT (they used to skip the health gate and print "done")
    # shellcheck disable=SC2086
    run_restore $e -- --yes "$DUMP"
    { [ "$rc" -eq 0 ] && grep -q "restore: backend healthy" <<< "$out_text" && grep -q "^restore: done" <<< "$out_text"; } || bad="$bad [$e rc=$rc]"
  done
  if [ -z "$bad" ]; then pass "(p6) wait settings: bad values refused, good values accepted"; else fail "(p6) wait settings:$bad"; fi
}

# (p7) a healthy reading counts only when the next poll agrees (same state, same restart
# count): passes once and then turns unhealthy -> exit 4; a restart in between restarts the
# confirmation; healthy, then starting until the wait runs out -> exit 4
{
  bad7=""
  run_restore "FAKE_HEALTH_LIST=running healthy 0;running unhealthy 0" RESTORE_WAIT_POLL=0.01 -- --yes "$DUMP"
  n1="$(wc -l < "$WORKDIR/inspect_count" | tr -d ' ')"
  { [ "$rc" -eq 4 ] && [ "$n1" = 2 ] && grep -q "is not healthy (unhealthy)" <<< "$out_text" && ! grep -q "backend healthy" <<< "$out_text"; } || bad7="$bad7 [healthy then unhealthy rc=$rc polls=$n1]"
  run_restore "FAKE_HEALTH_LIST=running healthy 0;running healthy 1;running healthy 1" RESTORE_WAIT_POLL=0.01 -- --yes "$DUMP"
  n2="$(wc -l < "$WORKDIR/inspect_count" | tr -d ' ')"
  { [ "$rc" -eq 0 ] && [ "$n2" = 3 ] && grep -q "restore: backend healthy" <<< "$out_text"; } || bad7="$bad7 [restart between polls rc=$rc polls=$n2]"
  run_restore "FAKE_HEALTH_LIST=running healthy 0;running starting 1" RESTORE_WAIT_SECONDS=1 RESTORE_WAIT_POLL=0.2 -- --yes "$DUMP"
  { [ "$rc" -eq 4 ] && grep -q "not healthy after 1s (last state: running starting 1)" <<< "$out_text"; } || bad7="$bad7 [healthy then starting rc=$rc]"
  run_restore "FAKE_HEALTH_LIST=running healthy 0" RESTORE_WAIT_SECONDS=0 RESTORE_WAIT_POLL=0.01 -- --yes "$DUMP"
  { [ "$rc" -eq 4 ] && grep -q "not stably healthy after 0s" <<< "$out_text"; } || bad7="$bad7 [one reading only rc=$rc]"
  if [ -z "${bad7:-}" ]; then pass "(p7) healthy must be confirmed by a second poll with the same restart count"; else fail "(p7) health confirmation:$bad7"; fi
}

# term_run <wait-pattern> <env...>: start restore.sh in the background, wait until the fake
# docker log shows <wait-pattern>, send TERM, set rc and out_text
term_run() {
  local pattern="$1"; shift
  : > "$FAKE_DOCKER_LOG"; rm -f "$FAKE_PSQL_STDIN"; rm -rf "$BACKUPS"
  env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" TMPDIR="$TMPD" "$@" \
    "$RESTORE_SCRIPT" --yes "${TERM_ARGS[@]}" "$DUMP" > "$WORKDIR/term.out" 2>&1 &
  local pid=$!
  for _ in $(seq 1 100); do grep -q -- "$pattern" "$FAKE_DOCKER_LOG" && break; sleep 0.1; done
  kill -TERM "$pid"
  rc=0; wait "$pid" || rc=$?
  out_text="$(cat "$WORKDIR/term.out")"
}

# (x) TERM while psql is loading: bash runs the trap only after the pipeline has finished, so
# the load may have committed. Exit 1, and the message says the state is unknown and how to
# start the backend. TERM before the load: the database is unchanged, the hint still printed.
{
  TERM_ARGS=(--no-pre-backup)
  term_run 'psql -v ON_ERROR_STOP' FAKE_PSQL_SLEEP=2
  if [ "$rc" -eq 1 ] && stdin_is_reset_plus_sql && grep -q "state of database 'deploy_panel' is unknown" <<< "$out_text" \
    && grep -q "backend may be stopped" <<< "$out_text" && grep -q "start backend" <<< "$out_text" && no_tmp_left; then
    pass "(x) TERM during the load -> exit 1, state unknown, backend start command printed"
  else
    fail "(x) TERM during the load: rc=$rc out=$out_text"
  fi
}

# (x2) TERM while the backend is being stopped (up to its grace period): the stop completes
# first, so the backend is stopped when the handler runs; the message must say how to start
# it. (x3) TERM before the load (here: during the pre-restore dump): same hint, database
# unchanged, and the script must not start the backend itself or touch the database
{
  TERM_ARGS=(--no-pre-backup)
  term_run ' stop backend' FAKE_STOP_SLEEP=1
  if [ "$rc" -eq 1 ] && grep -q "database is unchanged" <<< "$out_text" && grep -q "backend may be stopped" <<< "$out_text" \
    && grep -q "start backend" <<< "$out_text" && ! grep -q ' start backend' "$FAKE_DOCKER_LOG" && [ ! -e "$FAKE_PSQL_STDIN" ] && no_tmp_left; then
    pass "(x2) TERM during the backend stop -> exit 1, start command printed"
  else
    fail "(x2) TERM during stop: rc=$rc out=$out_text"
  fi
  TERM_ARGS=()
  term_run ' pg_dump ' FAKE_PGDUMP_SLEEP=1
  if [ "$rc" -eq 1 ] && grep -q "database is unchanged" <<< "$out_text" && grep -q "backend may be stopped" <<< "$out_text" \
    && grep -q "start backend" <<< "$out_text" && ! grep -q ' start backend' "$FAKE_DOCKER_LOG" && ! grep -q 'psql' "$FAKE_DOCKER_LOG" && no_tmp_left; then
    pass "(x3) TERM before the load -> exit 1, database unchanged, start command printed, backend not started, no psql"
  else
    fail "(x3) TERM before the load: rc=$rc out=$out_text"
  fi
}

# (s) the SQL read from the dump must carry the completion marker, as a whole line
{
  run_restore FAKE_CONVERT_MODE=nomarker -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && no_changing_calls && grep -q "completion marker" <<< "$out_text" && no_tmp_left; then pass "(s) SQL without the completion marker -> exit 1 before changing anything"; else fail "(s) no marker: rc=$rc"; fi
}

# (t) the given file disappears while the backend is being stopped: the SQL was read before,
# so the whole dump is restored and committed
{
  cp "$DUMP" "$WORKDIR/vanish.dump"
  run_restore FAKE_STOP_RM="$WORKDIR/vanish.dump" -- --yes "$WORKDIR/vanish.dump"
  if [ "$rc" -eq 0 ] && [ ! -e "$WORKDIR/vanish.dump" ] && stdin_is_reset_plus_sql && no_tmp_left; then
    pass "(t) file removed after the read: the SQL is restored in full and committed"
  else
    fail "(t) vanishing file: rc=$rc"
  fi
}

# (u) the private SQL copy itself becomes unreadable after validation: psql gets BEGIN and the
# reset but no COMMIT, the script exits 1 and says nothing was committed
{
  run_restore FAKE_STOP_RM="$TMPD/restore-dump.*" -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && [ -e "$FAKE_PSQL_STDIN" ] && ! grep -q 'COMMIT' "$FAKE_PSQL_STDIN" \
    && [ "$(sed -n 1p "$FAKE_PSQL_STDIN")" = "BEGIN;" ] \
    && grep -q "nothing was committed" <<< "$out_text" && ! grep -q "rolled back" <<< "$out_text" \
    && ! grep -q ' run ' "$FAKE_DOCKER_LOG" && ! grep -q ' start backend' "$FAKE_DOCKER_LOG" \
    && grep -q "still stopped" <<< "$out_text" && no_tmp_left; then
    pass "(u) unreadable copy -> exit 1, no COMMIT sent, backend left stopped"
  else
    fail "(u) unreadable copy: rc=$rc"
  fi
}

# (v) the temporary copy is removed on every exit path: success, refusal, invalid dump,
# stop failure, pre-backup failure, psql failure, start failure, db not running
{
  bad=0
  for envs in "" FAKE_STOP_FAIL=1 FAKE_PGDUMP_FAIL=1 FAKE_PSQL_FAIL=1 FAKE_START_FAIL=1 FAKE_RUNNING=backend FAKE_CONVERT_MODE=nomarker; do
    run_restore ${envs:+"$envs"} -- --yes "$DUMP"; no_tmp_left || { bad=1; echo "  leftover after '$envs'"; }
  done
  run_restore -- --yes "$WORKDIR/cutoff.dump"; no_tmp_left || { bad=1; echo "  leftover after cut-off dump"; }
  run_restore -- "$DUMP"; no_tmp_left || { bad=1; echo "  leftover after refusal"; }
  if [ "$bad" = 0 ]; then pass "(v) no temporary copy is left behind on any exit path"; else fail "(v) leftover temporary copy"; fi
}

# (w) a dump with transaction control statements is refused before anything is changed
{
  bad_w=""
  for stmt in 'COMMIT;' 'begin;' 'END;'; do
    run_restore "FAKE_CONVERT_MODE=txn:$stmt" -- --yes "$DUMP"
    if [ "$rc" -ne 1 ] || ! no_changing_calls || ! grep -q "transaction control" <<< "$out_text"; then bad_w="$stmt"; fi
  done
  if [ -z "$bad_w" ]; then pass "(w) transaction control statement in the dump -> exit 1 before changing anything"; else fail "(w) txn statement not refused: $bad_w"; fi
}

# (y) backup-roundtrip.sh refuses the production database container, by name and by compose
# project, before it touches anything (ROUNDTRIP_GUARD_ONLY=1 stops it right after the guard).
# A fake docker answers the two inspect queries: GUARD_NAME_LABEL for the container under
# test, GUARD_PROD_LABEL for the one named deploy-panel-db.
{
  GBIN="$WORKDIR/guardbin"; mkdir -p "$GBIN"
  cat > "$GBIN/docker" <<'EOF3'
#!/usr/bin/env bash
case "$*" in
  *"inspect -f {{.Name}}"*) [ "${GUARD_NAME_LABEL-unset}" != unset ] || exit 1; echo "$GUARD_NAME_LABEL" ;;
  *"inspect -f {{index"*"deploy-panel-db") [ "${GUARD_PROD_LABEL-unset}" != unset ] || exit 1; echo "$GUARD_PROD_LABEL" ;;
  *) echo "guard fake docker: unexpected call: $*" >&2; exit 9 ;;
esac
EOF3
  chmod +x "$GBIN/docker"
  guard_rc() { # guard_rc <name label> <prod label> [COMPOSE_PROJECT_NAME]
    local r=0
    env PATH="$GBIN:$PATH" DRILL_PG_CONTAINER=scratch ROUNDTRIP_GUARD_ONLY=1 GUARD_NAME_LABEL="$1" GUARD_PROD_LABEL="$2" \
      ${3:+COMPOSE_PROJECT_NAME="$3"} bash "$SCRIPT_DIR/backup-roundtrip.sh" > "$WORKDIR/guard.out" 2>&1 || r=$?
    echo "$r"
  }
  bad_y=""
  [ "$(guard_rc '/deploy-panel-db ' 'prodproj')" = 1 ] || bad_y="$bad_y [production name]"
  [ "$(guard_rc '/renamed-db prodproj' 'prodproj')" = 1 ] || bad_y="$bad_y [production project]"
  [ "$(guard_rc '/renamed-db sameproj' 'otherproj' 'sameproj')" = 1 ] || bad_y="$bad_y [COMPOSE_PROJECT_NAME]"
  grep -q "production" "$WORKDIR/guard.out" || bad_y="$bad_y [no message]"
  [ "$(guard_rc '/scratch-pg ' 'prodproj')" = 0 ] || bad_y="$bad_y [plain scratch container refused]"
  [ "$(guard_rc '/scratch-pg otherproj' 'prodproj')" = 0 ] || bad_y="$bad_y [other project refused]"
  [ "$(guard_rc '/scratch-pg ' 'unset-prod' )" = 0 ] || bad_y="$bad_y [scratch refused]"
  # Only the exact value 1 stops after the guard: any other value runs on into the round trip
  # (a stub npx stops it right there, before anything real happens).
  printf '#!/usr/bin/env bash\necho "guard test: npx reached" >&2\nexit 7\n' > "$GBIN/npx"; chmod +x "$GBIN/npx"
  for v in 0 yes; do
    env PATH="$GBIN:$PATH" DRILL_PG_CONTAINER=scratch ROUNDTRIP_GUARD_ONLY="$v" GUARD_NAME_LABEL='/scratch-pg ' GUARD_PROD_LABEL='prodproj' \
      bash "$SCRIPT_DIR/backup-roundtrip.sh" > "$WORKDIR/guard.out" 2>&1 || true
    { ! grep -q "roundtrip: guard passed" "$WORKDIR/guard.out" && grep -q "guard test: npx reached" "$WORKDIR/guard.out"; } \
      || bad_y="$bad_y [ROUNDTRIP_GUARD_ONLY=$v short-circuited]"
  done
  if [ -z "$bad_y" ]; then pass "(y) round-trip guard refuses the production container by name and compose project, accepts scratch ones"; else fail "(y) round-trip guard:$bad_y"; fi
}

echo "restore tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
