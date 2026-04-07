#!/bin/sh
set -e

echo "Running Prisma migrations..."
npx prisma db push --skip-generate 2>/dev/null || echo "Migration skipped (DB may not be ready yet)"

exec "$@"
