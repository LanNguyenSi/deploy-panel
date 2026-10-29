---
type: overview
title: Schema migrations mechanism — committed Prisma migrations applied by migrate.sh
description: Every path that applies the schema (Docker entrypoint, local `make db-migrate`) runs backend/scripts/migrate.sh, which uses `prisma migrate deploy` against the committed baseline migration, baselines a db-push database only when it equals schema.prisma, and never runs `prisma db push`; relay rollbacks restore code, not the schema.
tags: [prisma, migrations, entrypoint, rollback]
timestamp: 2026-10-29T08:00:00Z
sources:
  - backend/prisma/migrations/README.md
  - backend/scripts/migrate.sh
  - backend/backend-entrypoint.sh
  - backend/Dockerfile
  - Makefile
  - backend/prisma/schema.prisma
  - .relay.yml
---

# Schema migrations mechanism

The schema is applied by the migrations committed under
[`backend/prisma/migrations`](../../backend/prisma/migrations/README.md), one
baseline migration generated from `schema.prisma` plus whatever followed it.
Nothing in the repo runs `prisma db push` any more. Operator-facing detail
(the production one-time step, recovery commands, rollback limits) is in
[`docs/configuration.md`](../configuration.md#database-migrations); this doc
holds the cross-file picture.

## One script, three callers

`backend/scripts/migrate.sh` is the only code that touches the schema:

- **Docker / production**: `backend/backend-entrypoint.sh` runs it before
  `exec`ing the server, so the port only binds after the migrations applied
  and the relay's health check cannot pass earlier. It retries only the
  script's exit 3 ("could not check", the db-not-ready race); exit 1 (a
  differing database, a failed migration) is final and the container exits.
- **Local dev**: the root `Makefile`'s `db-migrate` target (also run by
  `make setup`; `db-push` survives only as an alias of it) and
  `npm run db:migrate --workspace=backend`.
- **CI**: the `migrations` job runs it against a Postgres service and
  `scripts/backend-migrate.test.sh` covers every outcome.

The script picks by database state: history table present or empty database
means `prisma migrate deploy`; tables without history (a database from the
`db push` releases) are baselined with `prisma migrate resolve --applied` only
when `prisma migrate diff --exit-code` says the database equals
`schema.prisma`, otherwise it exits 1 and changes nothing.

## The Prisma CLI is a runtime dependency

`prisma` sits in `backend/package.json` `dependencies`, so the runtime stage's
`npm ci --omit=dev` installs the version `package-lock.json` pins and
`migrate.sh` calls `node_modules/.bin/prisma` (not `npx`, which would fall
back to the registry). The Dockerfile's `npx --no-install prisma generate`
fails instead of downloading. A start therefore needs no network beyond the
database.

## Rollback restores code, not the schema

`.relay.yml` keeps `rollback: true` and declares no `post_update` hook: the
relay's rollback is `git reset --hard` plus rebuild and restart of the
previous image, and migrations are forward-only. The honest limits (add-only
migrations roll back safely, others need a manual step, rolling back past the
first migrations release makes the old `db push` drop unknown columns) are in
`docs/configuration.md#rollback-and-the-database-schema`.

## Don't

- Don't reintroduce `prisma db push` in an entrypoint, hook or Makefile path:
  it changes the schema without a migration and cannot be reviewed or rolled
  forward.
- Don't edit an already-deployed migration; add the next one. A schema change
  without a migration fails the CI `migrations` job.
- Don't swap `node_modules/.bin/prisma` for `npx prisma` in the script: a
  missing local install must fail, not download.
