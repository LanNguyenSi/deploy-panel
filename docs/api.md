# API reference

All endpoints are served by the Hono backend on `PORT` (default `3001`) and prefixed with `/api`. The UI uses the bare `/api/...` paths with cookie-session auth; CI/CD pipelines should use `/api/v1/...` with a `PANEL_TOKEN` Bearer token.

## Health

| Method | Path          | Description              |
|--------|---------------|--------------------------|
| GET    | `/api/health` | Health check, returns OK |

`/api/health` only proves the Hono process is up. For end-to-end verification (auth + Prisma queries + fleet reachability), run `scripts/smoke-check.sh`.

## Servers

| Method | Path                              | Description                                          |
|--------|-----------------------------------|------------------------------------------------------|
| GET    | `/api/servers`                    | List all servers (includes app count)                |
| GET    | `/api/servers/:id`                | Get a single server with its apps and deploy count   |
| POST   | `/api/servers`                    | Add a new server                                     |
| PATCH  | `/api/servers/:id`                | Update server fields                                 |
| DELETE | `/api/servers/:id`                | Delete server (cascades to apps and deploys)         |
| POST   | `/api/servers/:id/test`           | Test relay connectivity, pings relay `/health`       |
| GET    | `/api/servers/:id/system`         | Get system info (CPU, memory, disk) from relay       |
| POST   | `/api/servers/:serverId/sync`     | Sync apps list from relay to local database          |
| POST   | `/api/servers/:id/install-relay`  | Placeholder for SSH-based relay installation (501)   |

## Apps

All app endpoints are nested under a server: `/api/servers/:serverId/apps`.

| Method | Path                                            | Description                                    |
|--------|-------------------------------------------------|------------------------------------------------|
| GET    | `/api/servers/:serverId/apps`                   | List apps for a server                          |
| POST   | `/api/servers/:serverId/apps/:name/deploy`      | Trigger deploy (proxied to agent-relay)         |
| POST   | `/api/servers/:serverId/apps/:name/rollback`    | Trigger rollback (proxied to agent-relay)       |
| GET    | `/api/servers/:serverId/apps/:name/logs`        | Fetch app logs (proxied to agent-relay)         |
| GET    | `/api/servers/:serverId/apps/:name/preflight`   | Run preflight checks (proxied to agent-relay)   |

## Deploys

| Method | Path           | Description                                                        |
|--------|----------------|--------------------------------------------------------------------|
| GET    | `/api/deploys` | List deploys with optional filters: `serverId`, `appId`, `status`, `limit`, `offset`. Response includes `total` for pagination. |

## Audit

| Method | Path          | Description                                                        |
|--------|---------------|--------------------------------------------------------------------|
| GET    | `/api/audit`  | List audit log entries. Supports `limit` and `offset` query params; response includes `total` for pagination. |

## Scheduled deploys

| Method | Path                 | Description                        |
|--------|----------------------|------------------------------------|
| GET    | `/api/scheduled`     | List all scheduled deploy entries  |
| POST   | `/api/scheduled`     | Create a new scheduled deploy      |
| DELETE | `/api/scheduled/:id` | Delete a scheduled deploy          |

## API v1 (CI/CD pipeline integration)

All v1 endpoints are prefixed with `/api/v1` and authenticated via `PANEL_TOKEN` (Bearer token). They return JSON and are designed for non-interactive callers (GitHub Actions, GitLab pipelines, cron jobs).

| Method | Path                  | Description                                                        |
|--------|-----------------------|--------------------------------------------------------------------|
| GET    | `/api/v1/servers`     | List all servers                                                   |
| GET    | `/api/v1/apps`        | List all apps (optionally filtered by server)                      |
| POST   | `/api/v1/deploy`      | Trigger a deploy for a given app                                   |
| GET    | `/api/v1/deploy/:id`  | Get status of a specific deploy                                    |
| GET    | `/api/v1/deploys`     | List deploys with `offset` / `total` pagination                    |
| POST   | `/api/v1/rollback`    | Trigger a rollback for a given app                                 |
| GET    | `/api/v1/logs`        | Fetch logs for a given app                                         |
| POST   | `/api/v1/preflight`   | Run preflight checks for a given app                               |

Example: trigger a deploy from a CI job.

```bash
curl -X POST https://panel.example.com/api/v1/deploy \
  -H "Authorization: Bearer $PANEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serverId": "srv_abc", "appName": "web-prod"}'
```

The response includes a deploy id you can poll via `GET /api/v1/deploy/:id` to wait for `success` / `failed` / `rolled_back`.
