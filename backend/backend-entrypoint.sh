#!/bin/sh
#
# Production backend entrypoint.
#
# Brings the database to the committed Prisma migrations (backend/scripts/
# migrate.sh: prisma migrate deploy, never db push), then starts the server.
#
# History of the failure modes this script guards against:
#
#   1. A Prisma call without `--schema` finds no schema: Prisma looks for
#      `prisma/schema.prisma` relative to the current working dir, but the
#      image puts it at `backend/prisma/schema.prisma`. migrate.sh passes the
#      path on every call.
#
#   2. Swallowing the failure (`2>/dev/null || echo "skipped"`) kept the
#      container running with a schema drifted from the DB: a new nullable
#      column was enough to make every `findMany` on that table crash at
#      runtime and flip all servers to offline in the UI. The failure is
#      fatal here, so docker-compose marks the container unhealthy and
#      restarts it in a loop: noisy and visible in `docker compose logs`.
#
#   3. The CLI came from `npx`, which downloaded it from the npm registry on
#      every start. migrate.sh runs the CLI installed in node_modules, the
#      version package-lock.json pins; with no network it still works.
#
# Retry only the "could not check" outcome (migrate.sh exit 3, typically the
# database is not accepting connections yet: the boot race). Any other
# non-zero exit is definitive (the database differs from the schema and was
# left untouched, or a migration failed) and ends the container at once.
# MIGRATE_MAX_ATTEMPTS and MIGRATE_RETRY_DELAY exist so tests can shorten the
# loop; production uses the defaults.

set -e

MIGRATE=backend/scripts/migrate.sh
MAX_ATTEMPTS="${MIGRATE_MAX_ATTEMPTS:-10}"
RETRY_DELAY="${MIGRATE_RETRY_DELAY:-2}"

echo "[entrypoint] Applying database migrations ($MIGRATE)"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  # `set -e` does not apply to a command tested by `if`/`||`: capture the code.
  rc=0
  sh "$MIGRATE" || rc=$?

  if [ "$rc" -eq 0 ]; then
    echo "[entrypoint] Schema at the committed migrations."
    break
  fi

  if [ "$rc" -ne 3 ]; then
    echo "[entrypoint] migrations failed (exit $rc), see the message above. Not retrying; exiting."
    exit 1
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "[entrypoint] migrations could not be checked after $MAX_ATTEMPTS attempts, exiting."
    echo "[entrypoint] Check the Prisma error above: the database is not reachable or refuses the credentials."
    exit 1
  fi

  echo "[entrypoint] migration check attempt $attempt failed, retrying in ${RETRY_DELAY}s..."
  attempt=$((attempt + 1))
  sleep "$RETRY_DELAY"
done

exec "$@"
