#!/usr/bin/env bash
# Test driver for scripts/restore-drill.sh with a fake `docker` on PATH: no container or
# Postgres is needed. Run directly or from CI:
#   bash scripts/restore-drill.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRILL_SCRIPT="$SCRIPT_DIR/restore-drill.sh"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# The cases below set every input explicitly; nothing may leak in from the caller.
unset BACKUP_DIR DRILL_IMAGE DRILL_CONTAINER_PREFIX DRILL_WAIT_TRIES PG_USER PG_DB

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
export HOME="$WORKDIR/home"
mkdir -p "$HOME"
export FAKE_DOCKER_LOG="$WORKDIR/docker.log"
export WORKDIR

fail_count=0
pass_count=0
pass() { pass_count=$((pass_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); echo "FAIL: $1"; }

TABLES="servers apps app_secrets env_var_changes users sessions api_keys deploys audit_logs scheduled_deploys"

# What the fake pg_restore -f - prints: one COPY block per table, one line per row.
# Rows per table: users 2, sessions 1, app_secrets 3, deploys 5, every other table empty.
rows_for() {
  case "$1" in users) echo 2 ;; sessions) echo 1 ;; app_secrets) echo 3 ;; deploys) echo 5 ;; *) echo 0 ;; esac
}
make_sql() { # make_sql <file> [omitted table]; MAKE_COPY_ROW=1: the first users row starts with "COPY "
  : > "$1"
  printf -- '-- PostgreSQL database dump\nSET statement_timeout = 0;\n' >> "$1"
  for t in $TABLES; do
    [ "$t" != "${2:-}" ] || continue
    printf 'COPY public.%s (id, note) FROM stdin;\n' "$t" >> "$1"
    n="$(rows_for "$t")"
    i=0
    while [ "$i" -lt "$n" ]; do
      i=$((i + 1))
      if [ "${MAKE_COPY_ROW:-0}" = 1 ] && [ "$t" = users ] && [ "$i" = 1 ]; then
        printf 'COPY public.apps (x)\tdata row that looks like a COPY header\n' >> "$1"
      else
        printf 'row-%s\tvalue with COPY text\n' "$i" >> "$1"
      fi
    done
    printf '\\.\n\n' >> "$1"
  done
  printf -- '-- PostgreSQL database dump complete\n' >> "$1"
}
make_sql "$WORKDIR/full.sql"
make_sql "$WORKDIR/no_apps.sql" apps
MAKE_COPY_ROW=1 make_sql "$WORKDIR/copy_row.sql"
for t in $TABLES; do rows_for "$t" > "$WORKDIR/actual.$t"; done
# a table with zero rows everywhere
{ printf -- '-- PostgreSQL database dump\n'; for t in $TABLES; do printf 'COPY public.%s (id) FROM stdin;\n\\.\n' "$t"; done; } > "$WORKDIR/empty.sql"

# A stand-in for a custom-format dump; the content only has to differ between dumps.
make_dump() { { printf 'FAKEPGDMP %s\n' "$2"; for i in $(seq 1 200); do printf 'table data row %d\n' "$i"; done; } > "$1"; }

# Fake docker. FAKE_SQL picks the SQL that `pg_restore -f -` prints, FAKE_RUN_FAIL,
# FAKE_NEVER_READY and FAKE_RESTORE_FAIL make the matching step fail, and the row counts
# psql answers come from $WORKDIR/actual.<table>.
cat > "$FAKE_BIN/docker" <<'EOF2'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  "run "*)
    # FAKE_RUN_FAIL=1: fails before creating anything (name taken); FAKE_RUN_FAIL=created:
    # the container exists, then the start fails. Only a created container gets an id.
    all="$*"; cidfile="${all#*--cidfile }"; cidfile="${cidfile%% *}"
    [ "${FAKE_RUN_FAIL:-0}" = 1 ] && exit 1
    echo fake-container-id > "$cidfile"
    [ "${FAKE_RUN_FAIL:-0}" = created ] && exit 1
    echo fake-container-id; exit 0 ;;
  "rm "*) exit 0 ;;
  *"psql"*"SELECT 1"*) [ "${FAKE_NEVER_READY:-0}" = 1 ] && exit 2; echo 1; exit 0 ;;
  *"pg_restore --exit-on-error"*)
    cat > "$WORKDIR/restore_stdin"
    [ "${FAKE_RESTORE_FAIL:-0}" = 1 ] && { echo "pg_restore: error" >&2; exit 1; }
    exit 0 ;;
  *"pg_restore -f -"*) cat > /dev/null; cat "${FAKE_SQL:-$WORKDIR/full.sql}"; exit 0 ;;
  *"psql"*"SELECT count(*) FROM"*)
    all="$*"; t="${all##*FROM \"}"; t="${t%%\"*}"
    cat "$WORKDIR/actual.$t"; exit 0 ;;
  *) echo "fake docker: unexpected call: $*" >&2; exit 9 ;;
esac
EOF2
chmod +x "$FAKE_BIN/docker"

# run_drill [VAR=value ...] -- args...; sets rc, out_text
run_drill() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : > "$FAKE_DOCKER_LOG"; rm -f "$WORKDIR/restore_stdin"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" ${envs[@]+"${envs[@]}"} "$DRILL_SCRIPT" "$@" 2>&1)" || rc=$?
}
set_actual() { echo "$2" > "$WORKDIR/actual.$1"; }
reset_actual() { for t in $TABLES; do rows_for "$t" > "$WORKDIR/actual.$t"; done; }
no_docker_calls() { [ ! -s "$FAKE_DOCKER_LOG" ]; }
run_name() { sed -n 's/^run -d --name \([^ ]*\) .*/\1/p' "$FAKE_DOCKER_LOG" | head -1; }
# the container is removed again, by the id docker reported for it, and only that
removed_ok() {
  [ -n "$(run_name)" ] && [ "$(grep -c '^rm ' "$FAKE_DOCKER_LOG")" = 1 ] && grep -qx "rm -f fake-container-id" "$FAKE_DOCKER_LOG"
}
no_rm() { ! grep -q '^rm ' "$FAKE_DOCKER_LOG"; }

DUMPS="$WORKDIR/dumps"; mkdir -p "$DUMPS"
make_dump "$DUMPS/deploy-panel-20260101_000000.dump" old
make_dump "$DUMPS/deploy-panel-20260301_000000.dump" new
touch -t 202601010000 "$DUMPS/deploy-panel-20260101_000000.dump"
touch -t 202603010000 "$DUMPS/deploy-panel-20260301_000000.dump"

# (a) success: newest dump restored, every table compared, container removed
{
  reset_actual
  run_drill BACKUP_DIR="$DUMPS" --
  if [ "$rc" -eq 0 ] && grep -q "PASSED (11 rows in 10 tables)" <<< "$out_text" \
    && grep -q "drill: ok: users = 2" <<< "$out_text" && grep -q "drill: ok: scheduled_deploys = 0" <<< "$out_text" \
    && grep -q "^FAKEPGDMP new" "$WORKDIR/restore_stdin" && removed_ok \
    && grep -q "^run -d --name deploy-panel-drill-[0-9]* --cidfile [^ ]*/cid -e POSTGRES_USER=deploy_panel .* -e POSTGRES_DB=deploy_panel postgres:16-alpine$" "$FAKE_DOCKER_LOG" \
    && grep -q "pg_restore --exit-on-error --no-owner -U deploy_panel -d deploy_panel" "$FAKE_DOCKER_LOG"; then
    pass "(a) success: newest dump restored into a throwaway container, all tables compared, container removed"
  else
    fail "(a) success: rc=$rc"
  fi
}

# (a2) the throwaway container publishes no port and mounts no volume
{
  if ! grep -q -E ' (-p|--publish|-v|--volume|--network|--privileged) ' "$FAKE_DOCKER_LOG"; then
    pass "(a2) throwaway container has no published port, volume or network option"
  else
    fail "(a2) container options: $(grep '^run ' "$FAKE_DOCKER_LOG")"
  fi
}

# (b) one table with a different row count (fewer, then more) -> exit 1, named, container removed
{
  bad=0
  for v in 1 3; do
    reset_actual; set_actual users "$v"
    run_drill BACKUP_DIR="$DUMPS" --
    { [ "$rc" -eq 1 ] && grep -q "MISMATCH: users has $v rows after the restore, the dump holds 2" <<< "$out_text" \
      && ! grep -q PASSED <<< "$out_text" && removed_ok; } || bad=1
  done
  reset_actual
  if [ "$bad" = 0 ]; then pass "(b) row-count mismatch (fewer or more rows) -> exit 1, table named, container removed"; else fail "(b) mismatch: $out_text"; fi
}

# (b2) a mismatch in an empty table counts too, and later tables are still checked
{
  reset_actual; set_actual servers 4
  run_drill BACKUP_DIR="$DUMPS" --
  if [ "$rc" -eq 1 ] && grep -q "MISMATCH: servers has 4 rows" <<< "$out_text" && grep -q "ok: scheduled_deploys = 0" <<< "$out_text"; then
    pass "(b2) mismatch in an empty table -> exit 1, the remaining tables are still compared"
  else
    fail "(b2) empty-table mismatch: rc=$rc"
  fi
  reset_actual
}

# (c) a table missing from the dump -> exit 1
{
  run_drill FAKE_SQL="$WORKDIR/no_apps.sql" BACKUP_DIR="$DUMPS" --
  if [ "$rc" -eq 1 ] && grep -q "MISSING: table apps is not in the dump" <<< "$out_text" && removed_ok; then
    pass "(c) table missing from the dump -> exit 1"
  else
    fail "(c) missing table: rc=$rc"
  fi
}

# (d) pg_restore fails -> exit 1, no comparison, container removed
{
  run_drill FAKE_RESTORE_FAIL=1 BACKUP_DIR="$DUMPS" --
  if [ "$rc" -eq 1 ] && grep -q "pg_restore failed" <<< "$out_text" && ! grep -q "psql.*count" "$FAKE_DOCKER_LOG" && removed_ok; then
    pass "(d) pg_restore failure -> exit 1, container removed"
  else
    fail "(d) restore failure: rc=$rc"
  fi
}

# (e) the throwaway database never becomes ready, or docker run fails -> exit 1, still cleaned up
{
  run_drill FAKE_NEVER_READY=1 DRILL_WAIT_TRIES=1 BACKUP_DIR="$DUMPS" --; r1=$rc; k1=0; { grep -q "was not ready" <<< "$out_text" && removed_ok; } || k1=1
  run_drill FAKE_RUN_FAIL=created BACKUP_DIR="$DUMPS" --; r2=$rc; k2=0; { grep -q "could not start" <<< "$out_text" && removed_ok; } || k2=1
  if [ "$r1" = 1 ] && [ "$k1" = 0 ] && [ "$r2" = 1 ] && [ "$k2" = 0 ]; then
    pass "(e) database never ready / docker run fails after creating the container -> exit 1, container removed by id"
  else
    fail "(e) startup failures: $r1 $k1 $r2 $k2"
  fi
}

# (e2) docker run fails before creating a container (for example the name is taken):
# no id came back, so nothing is removed, in particular not a container of that name
{
  run_drill FAKE_RUN_FAIL=1 BACKUP_DIR="$DUMPS" --
  if [ "$rc" -eq 1 ] && grep -q "could not start" <<< "$out_text" && no_rm; then
    pass "(e2) docker run fails without creating a container -> exit 1, no docker rm (not by name either)"
  else
    fail "(e2) run failure without id: rc=$rc log=$(cat "$FAKE_DOCKER_LOG")"
  fi
}

# (f) nothing to restore: no dump, empty dir, missing dir, tiny file -> exit 2 before any docker call
{
  mkdir -p "$WORKDIR/emptydir"; printf 'x\n' > "$WORKDIR/tiny.dump"
  run_drill BACKUP_DIR="$WORKDIR/emptydir" --; r1=$rc; n1=0; no_docker_calls || n1=1
  run_drill BACKUP_DIR="$WORKDIR/nodir" --; r2=$rc; n2=0; no_docker_calls || n2=1
  run_drill BACKUP_DIR="$DUMPS" -- "$WORKDIR/tiny.dump"; r3=$rc; n3=0; no_docker_calls || n3=1
  run_drill BACKUP_DIR="$DUMPS" -- "$WORKDIR/missing.dump"; r4=$rc; n4=0; no_docker_calls || n4=1
  run_drill BACKUP_DIR="$DUMPS" -- a b; r5=$rc
  if [ "$r1$r2$r3$r4$r5" = 22222 ] && [ "$n1$n2$n3$n4" = 0000 ]; then
    pass "(f) no dump / missing dir / tiny file / missing file / two arguments -> exit 2, no docker call"
  else
    fail "(f) refusals: $r1 $r2 $r3 $r4 $r5 $n1 $n2 $n3 $n4"
  fi
}

# (g) dump source precedence: an explicit file wins over BACKUP_DIR; BACKUP_DIR set wins
#     over the HOME default; empty and unset BACKUP_DIR both mean $HOME/deploy-panel-backups
{
  reset_actual
  run_drill BACKUP_DIR="$DUMPS" -- "$DUMPS/deploy-panel-20260101_000000.dump"; r1=$rc; w1=0; grep -q "^FAKEPGDMP old" "$WORKDIR/restore_stdin" || w1=1
  mkdir -p "$HOME/deploy-panel-backups"; cp "$DUMPS/deploy-panel-20260101_000000.dump" "$HOME/deploy-panel-backups/"
  run_drill BACKUP_DIR= --; r2=$rc; w2=0; grep -q "^FAKEPGDMP old" "$WORKDIR/restore_stdin" || w2=1
  run_drill --; r3=$rc; w3=0; grep -q "^FAKEPGDMP old" "$WORKDIR/restore_stdin" || w3=1
  run_drill BACKUP_DIR="$DUMPS" --; r4=$rc; w4=0; grep -q "^FAKEPGDMP new" "$WORKDIR/restore_stdin" || w4=1
  run_drill BACKUP_DIR="$DUMPS" -- ""; r5=$rc; w5=0; grep -q "^FAKEPGDMP new" "$WORKDIR/restore_stdin" || w5=1
  if [ "$r1$r2$r3$r4$r5" = 00000 ] && [ "$w1$w2$w3$w4$w5" = 00000 ]; then
    pass "(g) explicit file > BACKUP_DIR > \$HOME default; empty BACKUP_DIR and empty file argument fall through"
  else
    fail "(g) precedence: $r1 $r2 $r3 $r4 $r5 / $w1 $w2 $w3 $w4 $w5"
  fi
}

# (h) PG_USER / PG_DB / DRILL_IMAGE / DRILL_CONTAINER_PREFIX reach docker; empty means default
{
  run_drill PG_USER=other_user PG_DB=other_db DRILL_IMAGE=postgres:17-alpine DRILL_CONTAINER_PREFIX=mydrill BACKUP_DIR="$DUMPS" --
  s1=0
  { grep -q "^run -d --name mydrill-[0-9]* --cidfile [^ ]*/cid -e POSTGRES_USER=other_user .* -e POSTGRES_DB=other_db postgres:17-alpine$" "$FAKE_DOCKER_LOG" \
    && grep -q "pg_restore --exit-on-error --no-owner -U other_user -d other_db" "$FAKE_DOCKER_LOG" \
    && grep -q 'psql -h 127.0.0.1 -U other_user -d other_db' "$FAKE_DOCKER_LOG"; } || s1=1
  run_drill PG_USER= PG_DB= DRILL_IMAGE= DRILL_CONTAINER_PREFIX= BACKUP_DIR="$DUMPS" --
  s2=0
  grep -q "^run -d --name deploy-panel-drill-[0-9]* --cidfile [^ ]*/cid -e POSTGRES_USER=deploy_panel .* -e POSTGRES_DB=deploy_panel postgres:16-alpine$" "$FAKE_DOCKER_LOG" || s2=1
  if [ "$s1" = 0 ] && [ "$s2" = 0 ]; then pass "(h) PG_USER, PG_DB, DRILL_IMAGE and DRILL_CONTAINER_PREFIX are honoured; empty falls back"; else fail "(h) overrides: $s1 $s2"; fi
}

# (i) bad DRILL_WAIT_TRIES -> exit 2 before docker
{
  run_drill DRILL_WAIT_TRIES=abc BACKUP_DIR="$DUMPS" --; r1=$rc; n1=0; no_docker_calls || n1=1
  run_drill DRILL_WAIT_TRIES=0 BACKUP_DIR="$DUMPS" --; r2=$rc
  if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$n1" = 0 ]; then pass "(i) bad DRILL_WAIT_TRIES -> exit 2"; else fail "(i) wait tries: $r1 $r2 $n1"; fi
}

# (j) a dump without any row passes the restore but says so
{
  for t in $TABLES; do echo 0 > "$WORKDIR/actual.$t"; done
  run_drill FAKE_SQL="$WORKDIR/empty.sql" BACKUP_DIR="$DUMPS" --
  if [ "$rc" -eq 0 ] && grep -q "holds no rows at all" <<< "$out_text" && grep -q "PASSED (0 rows" <<< "$out_text"; then
    pass "(j) an all-empty dump restores, with a warning that nothing was compared"
  else
    fail "(j) empty dump: rc=$rc"
  fi
  reset_actual
}

# (j2) a data row that starts with "COPY " is a row, not the header of a new block
{
  reset_actual
  run_drill FAKE_SQL="$WORKDIR/copy_row.sql" BACKUP_DIR="$DUMPS" --
  if [ "$rc" -eq 0 ] && grep -q "drill: ok: users = 2" <<< "$out_text" && grep -q "PASSED (11 rows in 10 tables)" <<< "$out_text"; then
    pass "(j2) a data row starting with COPY is counted as a row"
  else
    fail "(j2) COPY-looking data row: rc=$rc out=$out_text"
  fi
}

# (k) the TABLES list is the set of @@map names in the Prisma schema
{
  in_schema="$(sed -n 's/^[[:space:]]*@@map("\([a-z_]*\)").*/\1/p' "$REPO/backend/prisma/schema.prisma" | sort | tr '\n' ' ')"
  in_script="$(sed -n 's/^TABLES=(\(.*\))$/\1/p' "$DRILL_SCRIPT" | tr ' ' '\n' | sort | tr '\n' ' ')"
  in_test="$(echo "$TABLES" | tr ' ' '\n' | sort | tr '\n' ' ')"
  if [ -n "$in_schema" ] && [ "$in_schema" = "$in_script" ] && [ "$in_schema" = "$in_test" ]; then
    pass "(k) the drill's table list matches the @@map names in backend/prisma/schema.prisma"
  else
    fail "(k) table list: schema='$in_schema' script='$in_script' test='$in_test'"
  fi
}

echo "restore-drill tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
