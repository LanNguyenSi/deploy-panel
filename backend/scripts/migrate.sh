#!/bin/sh
# Brings the Postgres schema to the committed Prisma migrations in
# backend/prisma/migrations. The container entrypoint runs it before the server
# starts, and `make db-migrate` / `npm run db:migrate --workspace=backend` run
# it against a local database. It changes into the repository root (the image's
# WORKDIR /app) itself, so it works from any directory. It never runs
# `prisma db push`.
#
#   migration history (public._prisma_migrations) exists
#       -> prisma migrate deploy
#   no history, database empty
#       -> prisma migrate deploy (the baseline migration creates the schema)
#   no history, database not empty: a database from the releases that applied
#   the schema with prisma db push
#       -> only when it matches backend/prisma/schema.prisma exactly: record
#          the baseline migration as applied (prisma migrate resolve), then
#          prisma migrate deploy
#       -> any difference: stop with exit 1 and change nothing
#
# Exit codes (the entrypoint retries only on 3):
#   0  the schema is at the committed migrations
#   1  a definite failure: the database differs from the schema (nothing was
#      changed), or migrate resolve / migrate deploy failed
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
# database that already has exactly this schema.
BASELINE_MIGRATION=20261029120000_baseline
SCHEMA=backend/prisma/schema.prisma
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

if out=$(run_sql "$HISTORY_PRESENT_SQL" 2>&1); then
  say "migration history found, applying pending migrations."
  deploy_and_exit
fi
if ! absent_out=$(run_sql "$HISTORY_ABSENT_SQL" 2>&1); then
  printf '%s\n%s\n' "$out" "$absent_out" >&2
  err "could not tell whether the database has a migration history (see the Prisma errors above). Nothing was changed; the server does not start."
  exit 3
fi

empty_out=$(prisma migrate diff --from-empty --to-schema-datasource "$SCHEMA" --exit-code 2>&1)
rc=$?
case $rc in
  0)
    say "empty database, applying all migrations."
    deploy_and_exit
    ;;
  2) ;;
  *)
    printf '%s\n' "$empty_out" >&2
    err "could not tell whether the database is empty (prisma migrate diff exit $rc, see above). Nothing was changed; the server does not start."
    exit 3
    ;;
esac

say "the database has tables but no migration history (a database from before migrations); comparing it with $SCHEMA."
diff_out=$(prisma migrate diff --from-schema-datasource "$SCHEMA" --to-schema-datamodel "$SCHEMA" --exit-code 2>&1)
rc=$?
case $rc in
  0) ;;
  2)
    printf '%s\n' "$diff_out" >&2
    err "the database schema differs from $SCHEMA (the changes above would make it match)."
    err "Stopped before changing anything; the server does not start. The baseline migration $BASELINE_MIGRATION is recorded as applied only for a database that matches the schema exactly."
    err "Recovery ($GUIDE): back up the database (pg_dump), then either change the database to match the schema (npx prisma migrate diff --from-schema-datasource $SCHEMA --to-schema-datamodel $SCHEMA --script prints the SQL; review it, it can drop columns and data) or, when the difference is known to be harmless, run npx prisma migrate resolve --applied $BASELINE_MIGRATION --schema $SCHEMA; then start the backend again. Do not run prisma db push."
    exit 1
    ;;
  *)
    printf '%s\n' "$diff_out" >&2
    err "could not compare the database with $SCHEMA (prisma migrate diff exit $rc, see above). Nothing was changed; the server does not start."
    exit 3
    ;;
esac

say "the database matches $SCHEMA, recording the baseline migration $BASELINE_MIGRATION as applied."
if ! prisma migrate resolve --applied "$BASELINE_MIGRATION" --schema "$SCHEMA"; then
  err "prisma migrate resolve failed, see the Prisma error above. No migration was run; the server does not start. See $GUIDE."
  exit 1
fi
deploy_and_exit
