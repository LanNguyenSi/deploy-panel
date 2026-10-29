# Migrations directory

These migrations are **the mechanism that applies the schema** everywhere this
repo deploys. `backend/scripts/migrate.sh` runs `prisma migrate deploy` against
this directory:

- **Docker deployment / production**: the backend container's entrypoint runs
  `backend/scripts/migrate.sh` on every start, before the server binds its port
  (see docs/configuration.md, "Database migrations").
- **Local development**: `make db-migrate` (also run by `make setup`) runs the
  same script. Nothing in the repo runs `prisma db push` any more.

The folder holds one baseline migration, `20261029120000_baseline`, generated
from `schema.prisma` as it stood when the repo moved from `db push` to
migrations (the seven hand-written, replay-incomplete folders before it are in
git history). A database from before migrations that matches `schema.prisma`
exactly is recorded as having applied the baseline (`prisma migrate resolve`)
by the script; one that differs is left untouched and the container refuses to
start.

## The rule: a schema change is a new migration

Every change to `schema.prisma` ships with a new migration folder in the same
commit, named `YYYYMMDDHHMMSS_description`. CI applies the folder to an empty
Postgres and fails when the result differs from `schema.prisma`, so a schema
change without a migration does not merge.

Create it with one of:

```bash
# from the repo root, DATABASE_URL pointing at a dev database that is at the
# current migrations (a role that may create a shadow database)
npx prisma migrate dev --name add_something --schema backend/prisma/schema.prisma

# or print the SQL for review and write the folder by hand
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel backend/prisma/schema.prisma --script
```

Review the SQL before committing: Prisma writes `DROP COLUMN` for a removed
field, and a production table may hold data the dev database does not.

Migrations are forward-only. An already-deployed migration is never edited;
fix a mistake with the next migration. A relay rollback restores the previous
code, not the schema (docs/configuration.md, "Rollback and the database
schema"), so write a migration the previous release can still run against
(add columns as nullable or with a default, drop or rename in a later release
once nothing reads the old name).
