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
#   3. The schema step ran `npx prisma`, and prisma was only a devDependency
#      (the image's npx resolution depended on what happened to be installed).
#      prisma is now an explicit runtime dependency, and migrate.sh runs
#      node_modules/.bin/prisma, the version package-lock.json pins. No npm or
#      npx process runs at start, so it works with no network beyond the
#      database.
#
# Retry only the "could not check" outcome (migrate.sh exit 3, typically the
# database is not accepting connections yet: the boot race). Any other
# non-zero exit is definitive (the database differs from the schema and was
# left untouched, or a migration failed) and ends the container at once.
# MIGRATE_MAX_ATTEMPTS and MIGRATE_RETRY_DELAY exist so tests can shorten the
# loop; production uses the defaults (10, 2). An unset or empty variable means
# the default; a value that is not a plain decimal number (MIGRATE_MAX_ATTEMPTS
# >= 1, MIGRATE_RETRY_DELAY >= 0, at most 6 digits) stops the container with
# exit 1: a loop that never runs would start the server without migrating.

set -e

MIGRATE=backend/scripts/migrate.sh

# parse_int <name> <value> <minimum>: sets PARSED to the decimal value (leading
# zeros dropped, so 08 is 8 and never an octal error) or exits 1.
parse_int() {
  _v=$2
  case $_v in
    '' | *[!0-9]*) ;;
    *)
      while [ "${_v#0}" != "$_v" ]; do _v=${_v#0}; done
      [ -n "$_v" ] || _v=0
      if [ "${#_v}" -le 6 ] && [ "$_v" -ge "$3" ]; then
        PARSED=$_v
        return 0
      fi
      ;;
  esac
  echo "[entrypoint] $1 must be a whole number of at least $3 (at most 6 digits), got '$2'. Not starting." >&2
  exit 1
}

parse_int MIGRATE_MAX_ATTEMPTS "${MIGRATE_MAX_ATTEMPTS:-10}" 1
MAX_ATTEMPTS=$PARSED
parse_int MIGRATE_RETRY_DELAY "${MIGRATE_RETRY_DELAY:-2}" 0
RETRY_DELAY=$PARSED

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
