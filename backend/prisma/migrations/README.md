# Migrations directory

These migrations are **the mechanism that applies the schema** everywhere this
repo deploys. `backend/scripts/migrate.sh` runs `prisma migrate deploy` against
this directory:

- **Docker deployment / production**: the backend container's entrypoint runs
  `backend/scripts/migrate.sh` on every start, before the server binds its port
  (see docs/configuration.md, "Database migrations").
- **Local development**: `make db-migrate` (also run by `make setup`) runs the
  same script. No deploy or dev path runs `prisma db push` any more (CI and
  the test fixtures use it to build legacy databases).

The folder holds one baseline migration, `20261029120000_baseline`, generated
from `schema.prisma` as it stood when the repo moved from `db push` to
migrations (the seven hand-written, replay-incomplete folders before it are in
git history). That schema is frozen next to it as `../baseline.prisma`, which is
never edited: CI asserts that `prisma migrate diff --from-empty
--to-schema-datamodel backend/prisma/baseline.prisma --script` equals the
baseline migration's `migration.sql` byte for byte. A database from before
migrations that matches `baseline.prisma` exactly (not the current
`schema.prisma`, which later migrations change) is recorded as having applied
the baseline (`prisma migrate resolve`) by the script, and every later
migration is then applied; one that differs is left untouched and the
container refuses to start.

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
