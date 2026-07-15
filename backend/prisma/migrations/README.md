# Migrations directory

These `migration.sql` files are **documentation of schema history**, not the
mechanism that applies the schema anywhere this repo actually deploys.

- **Docker deployment / production**: the backend container's entrypoint
  runs `prisma db push` on startup (see docs/configuration.md "Docker
  deployment" and the root `docker-compose*.yml` files), which diffs
  `prisma/schema.prisma` against the live database directly — it does not
  read or apply anything under this directory.
- **Local development**: `make setup` / `make db-push` also run
  `prisma db push` (see the root `Makefile`), for the same reason.

So when `schema.prisma` changes, add a migration folder here anyway (one per
schema-affecting change, named `YYYYMMDD_description`, following the
existing folders) — it's the reviewable, human-readable record of what
changed and why, and it's what a future move to `prisma migrate deploy`
would replay. Just don't expect `prisma migrate dev/deploy` to have been run
against a live database as part of authoring one of these; verify a new
migration's SQL by inspection (and, ideally, by running it against a local
Postgres once one is available) rather than assuming CI or prod applies it.
