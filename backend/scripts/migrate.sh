#!/bin/sh
# Brings the Postgres schema to the committed Prisma migrations in
# backend/prisma/migrations. The container entrypoint runs it before the server
# starts, and `make db-migrate` / `npm run db:migrate --workspace=backend` run
# it against a local database. It changes into the repository root (the image's
# WORKDIR /app) itself, so it works from any directory. It never runs
# `prisma db push`.
#
#   migration history (public._prisma_migrations) with a finished migration
#       -> prisma migrate deploy
#   migration history without a finished migration (empty table, or only a
#   failed one), database has no tables
#       -> prisma migrate deploy (a failed row makes Prisma stop with P3009)
#   migration history without a finished migration, database has tables
#       -> stop with exit 1 and change nothing: running the baseline SQL on a
#          full database would fail and leave a failed row behind
#   no history, database empty
#       -> prisma migrate deploy (the baseline migration creates the schema)
#   no history, database not empty: a database from the releases that applied
#   the schema with prisma db push
#       -> only when it matches the frozen baseline schema
#          (backend/prisma/baseline.prisma, the schema the baseline migration
#          creates; NOT the current schema.prisma, which later migrations
#          change): record the baseline migration as applied (prisma migrate
#          resolve), then prisma migrate deploy applies every later migration
#       -> any difference: stop with exit 1 and change nothing
#
# Exit codes (the entrypoint retries only on 3):
#   0  the schema is at the committed migrations
#   1  a definite failure: the database differs from the baseline schema or has
#      a history table without a finished migration (nothing was changed), or
#      migrate resolve / migrate deploy failed
#   3  a check could not be answered (typically the database is not reachable
#      yet); nothing was changed
#
# Each check is read from exit codes only. A check that neither confirms nor
# rules out its condition counts as an error and exits 3. The database URL comes
# from DATABASE_URL through the datasource in schema.prisma (Prisma also reads
# .env files), never from the command line. Only the default schema is
# supported: Prisma Migrate keeps its history in public unless DATABASE_URL
# selects another schema, and these checks look there.
set -u

# The first migration: the schema the db push releases applied, as one
# migration. Recording it as applied without running it is only right for a
# database that already has exactly this schema, and BASELINE_SCHEMA is that
# schema, frozen: CI keeps it equal to the migration's SQL.
BASELINE_MIGRATION=20261029120000_baseline
SCHEMA=backend/prisma/schema.prisma
BASELINE_SCHEMA=backend/prisma/baseline.prisma
GUIDE='docs/configuration.md, "Database migrations"'

say() { echo "migrate: $*"; }
err() { echo "migrate: $*" >&2; }

cd "$(dirname "$0")/../.." || { err "cannot change into the repository root"; exit 1; }

# The CLI installed in node_modules, the version package-lock.json pins. Not
# npx: without a local install npx falls back to the registry or its download
# cache, which can hold any version. PRISMA_CLI replaces the path (the tests
# point it at a stub).
prisma() { "${PRISMA_CLI:-node_modules/.bin/prisma}" "$@"; }

run_sql() { printf '%s\n' "$1" | prisma db execute --stdin --schema "$SCHEMA"; }

# `prisma db execute` returns no rows, so each probe answers with its exit
# code: it raises an exception unless its condition holds. Two opposite probes,
# so that a connection or permission error (both fail) is not taken for an
# answer. The $ signs are SQL dollar quotes, not shell expansions.
# shellcheck disable=SC2016
HISTORY_PRESENT_SQL='DO $$ BEGIN IF to_regclass($q$public._prisma_migrations$q$) IS NULL THEN RAISE EXCEPTION $q$no migration history table$q$; END IF; END $$;'
# shellcheck disable=SC2016
HISTORY_ABSENT_SQL='DO $$ BEGIN IF to_regclass($q$public._prisma_migrations$q$) IS NOT NULL THEN RAISE EXCEPTION $q$migration history table exists$q$; END IF; END $$;'
# Only run once the history table is known to exist.
# shellcheck disable=SC2016
HISTORY_FINISHED_SQL='DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NOT NULL) THEN RAISE EXCEPTION $q$no finished migration$q$; END IF; END $$;'
# shellcheck disable=SC2016
HISTORY_UNFINISHED_SQL='DO $$ BEGIN IF EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NOT NULL) THEN RAISE EXCEPTION $q$a finished migration exists$q$; END IF; END $$;'

deploy_and_exit() {
  prisma migrate deploy --schema "$SCHEMA"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    err "prisma migrate deploy failed (exit $rc), see the Prisma error above."
    err "A failed migration stays recorded in _prisma_migrations and blocks the next deploys until it is resolved; see $GUIDE."
    exit 1
  fi
  say "the database schema is at the committed migrations."
  exit 0
}

case ${DATABASE_URL:-} in
  *'?schema=public' | *'&schema=public' | *'?schema=public&'* | *'&schema=public&'*) ;;
  *'?schema='* | *'&schema='*)
    err "DATABASE_URL selects a schema other than public; this script checks the migration history in public only and stops here. Nothing was changed."
    exit 1
    ;;
esac

# check_empty: sets EMPTY to yes (the database has no tables of its own) or no.
# `migrate diff` ignores the _prisma_migrations table, so this is about the
# application tables only. Exits 3 when the check cannot answer.
check_empty() {
  empty_out=$(prisma migrate diff --from-empty --to-schema-datasource "$SCHEMA" --exit-code 2>&1)
  rc=$?
  case $rc in
    0) EMPTY=yes ;;
    2) EMPTY=no ;;
    *)
      printf '%s\n' "$empty_out" >&2
      err "could not tell whether the database is empty (prisma migrate diff exit $rc, see above). Nothing was changed; the server does not start."
      exit 3
      ;;
  esac
}

if out=$(run_sql "$HISTORY_PRESENT_SQL" 2>&1); then
  # A history table with a finished migration is the normal case. One without
  # (a stale or empty table) next to application tables must not reach the
  # baseline SQL: it would fail on the existing tables and leave a failed row
  # that blocks every later start (P3009).
  if finished_out=$(run_sql "$HISTORY_FINISHED_SQL" 2>&1); then
    say "migration history found, applying pending migrations."
    deploy_and_exit
  fi
  if ! unfinished_out=$(run_sql "$HISTORY_UNFINISHED_SQL" 2>&1); then
    printf '%s\n%s\n' "$finished_out" "$unfinished_out" >&2
    err "could not read the migration history (see the Prisma errors above). Nothing was changed; the server does not start."
    exit 3
  fi
  check_empty
  if [ "$EMPTY" = yes ]; then
    say "migration history without a finished migration, database has no tables; applying pending migrations."
    deploy_and_exit
  fi
  err "the database has tables and a migration history table (public._prisma_migrations) in which no migration is finished."
  err "Running the baseline migration would fail on the existing tables and leave a failed row that blocks every later start. Stopped before changing anything; the server does not start."
  err "Recovery ($GUIDE): back up the database (pg_dump), inspect the table (SELECT * FROM _prisma_migrations). If the tables are a database from before migrations and the history table is a leftover, drop the history table (DROP TABLE _prisma_migrations) and start the backend again; the next start compares the tables with $BASELINE_SCHEMA. Do not run prisma db push."
  exit 1
fi
if ! absent_out=$(run_sql "$HISTORY_ABSENT_SQL" 2>&1); then
  printf '%s\n%s\n' "$out" "$absent_out" >&2
  err "could not tell whether the database has a migration history (see the Prisma errors above). Nothing was changed; the server does not start."
  exit 3
fi

check_empty
if [ "$EMPTY" = yes ]; then
  say "empty database, applying all migrations."
  deploy_and_exit
fi

say "the database has tables but no migration history (a database from before migrations); comparing it with the baseline schema $BASELINE_SCHEMA."
if [ ! -f "$BASELINE_SCHEMA" ]; then
  err "$BASELINE_SCHEMA is missing (it is the schema the baseline migration $BASELINE_MIGRATION creates, committed with the migrations). Nothing was changed; the server does not start."
  exit 1
fi
diff_out=$(prisma migrate diff --from-schema-datasource "$SCHEMA" --to-schema-datamodel "$BASELINE_SCHEMA" --exit-code 2>&1)
rc=$?
case $rc in
  0) ;;
  2)
    printf '%s\n' "$diff_out" >&2
    err "the database schema differs from the baseline schema $BASELINE_SCHEMA (the changes above would make it match). The comparison is with the baseline, not with the current $SCHEMA: later migrations are applied after the baseline is recorded."
    err "Stopped before changing anything; the server does not start. The baseline migration $BASELINE_MIGRATION is recorded as applied only for a database that matches the baseline schema exactly."
    err "Recovery ($GUIDE): back up the database (pg_dump), then either align the database with the baseline (npx --no-install prisma migrate diff --from-schema-datasource $SCHEMA --to-schema-datamodel $BASELINE_SCHEMA --script prints the SQL; review it, it can drop columns and data) or, when the difference is known to be harmless, resolve by hand after review: npx --no-install prisma migrate resolve --applied $BASELINE_MIGRATION --schema $SCHEMA; then start the backend again (later migrations are applied by the start). Do not run prisma db push."
    exit 1
    ;;
  *)
    printf '%s\n' "$diff_out" >&2
    err "could not compare the database with $BASELINE_SCHEMA (prisma migrate diff exit $rc, see above). Nothing was changed; the server does not start."
    exit 3
    ;;
esac

say "the database matches the baseline schema $BASELINE_SCHEMA, recording the baseline migration $BASELINE_MIGRATION as applied."
if ! prisma migrate resolve --applied "$BASELINE_MIGRATION" --schema "$SCHEMA"; then
  err "prisma migrate resolve failed, see the Prisma error above. No migration was run; the server does not start. See $GUIDE."
  exit 1
fi
deploy_and_exit
