# Contributing to deploy-panel

Thanks for your interest. deploy-panel is a web-based control panel for managing VPS deployments. Live: [deploy-panel.opentriologue.ai](https://deploy-panel.opentriologue.ai).

## Issues

- Bug reports: include repro steps, expected vs. actual, the affected surface (`backend`, `frontend`, `mcp`, `action`).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `main` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the local checks scoped to the affected surface:

   ```bash
   # backend or frontend (npm workspaces)
   npm install
   npm run build --workspace=<backend|frontend>
   npm run test  --workspace=<backend|frontend>

   # mcp (standalone npm package, not in root workspaces)
   cd mcp && npm install && npm run build && npm test

   # action is a GitHub composite action; no npm build, just edit action.yml
   ```

4. For deployment-path changes, dogfood against a real or staging VPS target via `docker compose -f docker-compose.prod.yml`.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/deploy-panel.git
cd deploy-panel
cp .env.example .env

npm install
docker compose up -d db                          # Postgres only, published on 127.0.0.1:5433
npx prisma generate --schema backend/prisma/schema.prisma
set -a; . ./.env; set +a                         # host-run processes below don't load .env themselves
npx prisma db push --schema backend/prisma/schema.prisma   # run from the repo root

make dev                                          # backend on :3001, frontend on :3000, hot reload
```

`make build` (build both workspaces) also needs the generated Prisma client: run it after the `prisma generate` step, otherwise the backend `tsc` build fails. Run it in a shell that has not exported `.env`, or prefix it with `env -u NODE_ENV`: `.env.example` sets `NODE_ENV=development`, which makes `next build` fail. `make dev` additionally needs Postgres and an exported `.env`; neither `make dev` nor `make db-push` reads `.env` itself. This block mirrors the README [Quick start](README.md#quick-start). The full Docker stack (`make docker-up` / `make setup`) additionally requires `APP_SECRETS_KEY` in `.env`.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
