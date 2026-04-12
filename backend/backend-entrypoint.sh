#!/bin/sh
#
# Production backend entrypoint.
#
# The previous version of this script had two bugs:
#
#   1. `npx prisma db push` without `--schema` — Prisma looks for
#      `prisma/schema.prisma` relative to the current working dir, but
#      the image puts it at `backend/prisma/schema.prisma`. Every push
#      failed with "Could not find Prisma Schema".
#
#   2. `2>/dev/null || echo "Migration skipped ..."` swallowed the
#      failure silently and kept the container running with a schema
#      drifted from the DB. A schema change (adding a nullable column)
#      was enough to make every `findMany` on that table crash at
#      runtime, which then cascaded into sync failures and flipped all
#      servers to offline in the UI.
#
# The fix: give Prisma the correct schema path, retry a few times to
# handle the "db not ready yet" boot race, and FAIL LOUDLY if push
# never succeeds. A failed push should exit non-zero, docker-compose
# will mark the container unhealthy and restart it in a loop — noisy
# and visible in `docker compose logs`, not silently broken.

set -e

SCHEMA=backend/prisma/schema.prisma
MAX_ATTEMPTS=10

echo "[entrypoint] Running prisma db push (schema=$SCHEMA)"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  if npx prisma db push --schema="$SCHEMA" --skip-generate; then
    echo "[entrypoint] Schema in sync."
    break
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "[entrypoint] db push failed after $MAX_ATTEMPTS attempts — exiting."
    echo "[entrypoint] This is not the same as 'db not ready'. Check the Prisma"
    echo "[entrypoint] error above — likely a genuine schema conflict."
    exit 1
  fi

  echo "[entrypoint] db push attempt $attempt failed, retrying in 2s..."
  attempt=$((attempt + 1))
  sleep 2
done

exec "$@"
