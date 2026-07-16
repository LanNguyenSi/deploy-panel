---
type: overview
title: Schema migrations mechanism — pointer to the migrations README
description: Pointer doc — backend/prisma/migrations/README.md is the authoritative statement that migration.sql files are documentation-only; every path that actually applies the schema (Docker entrypoint, local `make db-push`) runs `prisma db push`, never `prisma migrate deploy`.
tags: [prisma, migrations, pointer]
timestamp: 2026-07-16T05:46:15Z
sources:
  - backend/prisma/migrations/README.md
  - backend/backend-entrypoint.sh
  - Makefile
  - backend/prisma/schema.prisma
---

# Schema migrations mechanism — pointer

The authoritative reference is
[`backend/prisma/migrations/README.md`](../../backend/prisma/migrations/README.md):
`migration.sql` files under this directory are schema-history documentation
only. Nothing in this repo's actual deploy or dev path reads or applies
them — it is current against master and deliberately not restated here.

The two call sites that actually mutate a live database schema, both running
`prisma db push` against `prisma/schema.prisma` directly:

- **Docker / production**: `backend/backend-entrypoint.sh` runs
  `npx prisma db push --schema="$SCHEMA" --skip-generate` on container
  startup, with a small retry loop.
- **Local dev**: the root `Makefile`'s `db-push` target (`cd backend && npx
  prisma db push`), invoked directly or via `make setup`.

So when `schema.prisma` changes, add a migration folder anyway for the
reviewable record (per the README's own instructions) — just don't expect
`prisma migrate dev/deploy` to have touched a live database as part of
authoring one.
