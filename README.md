# deploy-panel

Web-based control panel for managing VPS deployments. Works together with [agent-relay](https://github.com/LanNguyenSi/agent-relay) to provide a visual interface for server management, app deployments, rollbacks, and deploy history.

## Features

- **Server management** -- add, edit, remove VPS servers; test relay connectivity
- **App management** -- view apps per server, trigger deploys and rollbacks, run preflight checks, view logs
- **Deploy history** -- filterable timeline of all deployments with status, commit SHAs, duration
- **Dashboard** -- overview of server fleet with online/offline counts, app totals, and recent deploys
- **Relay integration** -- proxies deploy/rollback/logs/preflight requests to agent-relay instances running on each VPS

## Architecture

```
Browser --> Next.js frontend --> Hono backend --> agent-relay on VPS
                                     |
                                  PostgreSQL
```

| Layer    | Stack                                   |
|----------|-----------------------------------------|
| Frontend | Next.js 15, React 19                    |
| Backend  | Hono, Prisma, Zod, Node.js 22           |
| Database | PostgreSQL 16                            |
| Relay    | HTTP client proxying to agent-relay APIs |

The backend stores server/app/deploy metadata in PostgreSQL via Prisma. When a deploy, rollback, log fetch, or preflight check is requested, the backend looks up the server's `relayUrl` and `relayToken`, then forwards the request to the agent-relay instance on that VPS.

## Backend API Reference

All endpoints are prefixed with `/api`.

### Health

| Method | Path          | Description              |
|--------|---------------|--------------------------|
| GET    | `/api/health` | Health check (returns OK) |

### Servers

| Method | Path                            | Description                                        |
|--------|---------------------------------|----------------------------------------------------|
| GET    | `/api/servers`                  | List all servers (includes app count)               |
| GET    | `/api/servers/:id`              | Get single server with its apps and deploy count    |
| POST   | `/api/servers`                  | Add a new server                                    |
| PATCH  | `/api/servers/:id`              | Update server fields                                |
| DELETE | `/api/servers/:id`              | Delete server (cascades to apps and deploys)         |
| POST   | `/api/servers/:id/test`         | Test relay connectivity (pings relay `/health`)      |
| POST   | `/api/servers/:id/install-relay`| Placeholder for SSH-based relay installation (501)   |

### Apps

All app endpoints are nested under a server: `/api/servers/:serverId/apps`.

| Method | Path                                            | Description                                    |
|--------|-------------------------------------------------|------------------------------------------------|
| GET    | `/api/servers/:serverId/apps`                   | List apps for a server                          |
| POST   | `/api/servers/:serverId/apps/:name/deploy`      | Trigger deploy (proxied to agent-relay)          |
| POST   | `/api/servers/:serverId/apps/:name/rollback`    | Trigger rollback (proxied to agent-relay)        |
| GET    | `/api/servers/:serverId/apps/:name/logs`        | Fetch app logs (proxied to agent-relay)          |
| GET    | `/api/servers/:serverId/apps/:name/preflight`   | Run preflight checks (proxied to agent-relay)    |

### Deploys

| Method | Path           | Description                                                        |
|--------|----------------|--------------------------------------------------------------------|
| GET    | `/api/deploys` | List deploys with optional filters: `serverId`, `appId`, `status`, `limit` |

## Frontend Pages

| Route              | Page             | Description                                                                 |
|--------------------|------------------|-----------------------------------------------------------------------------|
| `/`                | Dashboard        | Overview with server count, app count, online status, and recent deploys     |
| `/servers`         | Server List      | Add/remove servers, test relay connections, view status badges               |
| `/servers/[id]`    | App Management   | View apps on a server; deploy, rollback, view logs, run preflight checks     |
| `/deploys`         | Deploy History   | Filterable table of all deployments with status, commit, duration, timestamp |

## Relay Integration

deploy-panel communicates with [agent-relay](https://github.com/LanNguyenSi/agent-relay) instances via HTTP. Each server record stores a `relayUrl` (e.g. `http://vps-ip:3002`) and an optional `relayToken` for Bearer authentication.

When the panel triggers a deploy, rollback, log fetch, or preflight check, the backend:

1. Looks up the server's relay credentials from the database
2. Forwards the request to the agent-relay HTTP API (e.g. `POST /api/deploy`, `POST /api/rollback`, `GET /api/logs`, `GET /api/preflight`)
3. Records the result in the `deploys` table and updates the app status

Requests to agent-relay have a 30-second timeout. If the relay is unreachable or returns an error, the deploy is marked as failed.

## Running Locally

### Prerequisites

- Node.js 20+
- Docker (for PostgreSQL)

### Quick Start

```bash
git clone https://github.com/LanNguyenSi/deploy-panel.git
cd deploy-panel
cp .env.example .env        # edit .env if needed
make setup                  # installs deps, starts PostgreSQL, runs Prisma generate + push
make dev                    # starts backend (port 3001) + frontend (port 3000)
```

### Make Targets

| Target         | Description                                   |
|----------------|-----------------------------------------------|
| `make setup`   | Install deps, start DB, generate Prisma client |
| `make dev`     | Run backend + frontend concurrently            |
| `make build`   | Build both backend and frontend                |
| `make docker-up` | Start PostgreSQL container                   |
| `make docker-down` | Stop PostgreSQL container                  |
| `make db-generate` | Run `prisma generate`                      |
| `make db-push`     | Run `prisma db push`                       |
| `make clean`       | Remove build artifacts and node_modules    |

## Environment Variables

| Variable             | Required | Default                          | Description                          |
|----------------------|----------|----------------------------------|--------------------------------------|
| `DATABASE_URL`       | Yes      | --                               | PostgreSQL connection string         |
| `SESSION_SECRET`     | Yes      | --                               | Session signing secret (min 16 chars)|
| `PORT`               | No       | `3001`                           | Backend port                         |
| `CORS_ORIGINS`       | No       | `http://localhost:3000`          | Allowed CORS origins                 |
| `FRONTEND_URL`       | No       | `http://localhost:3000`          | Frontend URL                         |
| `NODE_ENV`           | No       | `development`                    | Node environment                     |
| `NEXT_PUBLIC_API_URL`| No       | `http://localhost:3001`          | API URL used by the frontend         |
| `POSTGRES_USER`      | No       | `deploy_panel`                   | PostgreSQL user (Docker)             |
| `POSTGRES_PASSWORD`  | No       | `deploy_panel`                   | PostgreSQL password (Docker)         |
| `POSTGRES_DB`        | No       | `deploy_panel`                   | PostgreSQL database name (Docker)    |
| `FRONTEND_PORT`      | No       | `3000`                           | Host port for frontend (Docker)      |

## Docker Deployment

The project includes a full `docker-compose.yml` that runs PostgreSQL, the backend, and the frontend as containers.

```bash
# Build and start all services
cp .env.example .env
# Edit .env -- set SESSION_SECRET to a secure value and adjust NEXT_PUBLIC_API_URL
# to the public URL where the backend will be reachable

docker compose up -d --build
```

The compose stack includes:

- **db** -- PostgreSQL 16 Alpine with a persistent volume and health check
- **backend** -- Multi-stage build (Node 22 Alpine), runs Prisma migrations on startup via entrypoint script, exposes port 3001 internally
- **frontend** -- Multi-stage build (Node 22 Alpine) with Next.js standalone output, exposed on `FRONTEND_PORT` (default 3000)

The backend waits for the database health check before starting. The frontend waits for the backend health check before starting. Only the frontend port is published to the host by default.

## Data Model

- **Server** -- VPS instances with host, SSH key path, relay URL/token, and connection status (`unknown`, `online`, `offline`, `no-relay`)
- **App** -- Deployed applications per server with health status (`unknown`, `healthy`, `unhealthy`, `deploying`); unique per server+name
- **Deploy** -- Deployment history with commit SHAs (before/after), status (`pending`, `running`, `success`, `failed`, `rolled_back`), duration, logs, and trigger source

## Related

- [agent-relay](https://github.com/LanNguyenSi/agent-relay) -- VPS daemon that executes deployments

## License

[MIT](LICENSE)
