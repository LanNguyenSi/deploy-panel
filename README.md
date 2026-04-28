# deploy-panel

Web control panel for VPS deployments, paired with [agent-relay](https://github.com/LanNguyenSi/agent-relay).

[![CI](https://github.com/LanNguyenSi/deploy-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/LanNguyenSi/deploy-panel/actions/workflows/ci.yml)

<!-- TODO: hero screenshot of the dashboard -->

deploy-panel is a Next.js + Hono app that drives a fleet of VPS servers running [agent-relay](https://github.com/LanNguyenSi/agent-relay). It tracks servers, apps, and deploy history in PostgreSQL via Prisma, and proxies deploy / rollback / logs / preflight requests to each VPS's relay over HTTP. Built so a small team (or solo operator) can ship to a handful of boxes without juggling SSH tabs.

## Try it in 60 seconds

```bash
git clone https://github.com/LanNguyenSi/deploy-panel.git
cd deploy-panel
cp .env.example .env

# installs deps, starts PostgreSQL in Docker, runs prisma generate + db push
make setup

# starts backend on :3001 and frontend on :3000
make dev
```

Open http://localhost:3000, add a server (host + `relayUrl` + optional `relayToken`), hit "Test connection", then deploy from the app list.

## What it looks like

Dashboard, fleet overview:

```
# example output
Servers   3 online / 0 offline / 0 no-relay
Apps      11 healthy / 1 unhealthy / 0 deploying
Recent    web-prod      success    2m ago    (a1b2c3d -> e4f5g6h)
          api-staging   success    14m ago   (9e8d7c6 -> 5b4a3c2)
          worker-prod   failed     1h ago    (timeout reaching relay)
```

API v1 deploy from a CI job:

```bash
curl -X POST https://panel.example.com/api/v1/deploy \
  -H "Authorization: Bearer $PANEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serverId": "srv_abc", "appName": "web-prod"}'
```

## Next steps

| If you want to... | Read |
|------|------|
| Understand the layers (frontend, backend, relay proxy, data model) | [docs/architecture.md](docs/architecture.md) |
| Configure env vars, ports, sessions, CORS, Docker deployment | [docs/configuration.md](docs/configuration.md) |
| Call the REST API (panel UI endpoints + `/api/v1` for CI/CD) | [docs/api.md](docs/api.md) |

## Development

```bash
make setup          # one-time: deps, DB, Prisma client
make dev            # backend + frontend, hot reload
make build          # build both workspaces
make docker-up      # start PostgreSQL only (port 5433)
make docker-down    # stop PostgreSQL
make db-generate    # prisma generate
make db-push        # prisma db push (apply schema)
make clean          # remove dist + node_modules
```

Workspaces: `backend/` (Hono + Prisma + Zod, Node 20+) and `frontend/` (Next.js 15, React 19). Shared root `package.json` declares both as npm workspaces.

After deploying to a real environment, run the smoke check to verify auth, Prisma-backed queries, and fleet reachability against the live instance:

```bash
DEPLOY_PANEL_URL=https://deploy-panel.example.com \
PANEL_TOKEN=... \
./scripts/smoke-check.sh
```

Exits 0 on success. Unlike `/api/health` (which only proves the Hono process is up), this script exercises real DB queries, so schema drift surfaces immediately. Requires `curl` and `jq`.

## Docker deployment

The repo ships a full `docker-compose.yml` for db + backend + frontend:

```bash
cp .env.example .env
# edit .env: set SESSION_SECRET to a real value, point NEXT_PUBLIC_API_URL at
# the public URL where the backend will be reachable
docker compose up -d --build
```

The backend waits for the db health check before starting, the frontend waits for the backend, and only the frontend port is published by default. See [docs/configuration.md](docs/configuration.md) for the full env var matrix and production notes.

## Related

- [agent-relay](https://github.com/LanNguyenSi/agent-relay), the VPS daemon that actually runs deploys; deploy-panel is the UI in front of it.

## License

[MIT](LICENSE)
