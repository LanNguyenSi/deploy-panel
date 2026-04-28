# Architecture

How deploy-panel turns a fleet of VPS boxes into a single web UI plus a CI-friendly REST API.

## Layers

```
   Browser
      |
      v
 [Next.js 15 frontend]   (React 19, app router, port 3000)
      |
      v
 [Hono backend]          (Node 20+, port 3001, /api and /api/v1)
      |    |
      |    +--> [PostgreSQL 16]   servers, apps, deploys, audit, scheduled
      |
      v
 [agent-relay on each VPS]  (HTTP, deploy / rollback / logs / preflight)
```

The frontend is a thin client over the backend's REST API. The backend owns all persistence (Prisma + PostgreSQL) and is the only thing that talks to relays. There is no direct browser-to-relay path: every relay call is proxied through the backend so the panel can record audit entries, attach the right `relayToken`, and update deploy status in one place.

## Stack

| Layer    | Stack                                   |
|----------|-----------------------------------------|
| Frontend | Next.js 15, React 19                    |
| Backend  | Hono, Prisma, Zod, Node.js 20+          |
| Database | PostgreSQL 16                            |
| Relay    | HTTP client proxying to agent-relay APIs |

## Relay integration

Each `Server` row stores a `relayUrl` (e.g. `http://vps-ip:3002`) and an optional `relayToken` for Bearer authentication. When the panel triggers a deploy, rollback, log fetch, or preflight check, the backend:

1. Looks up the server's relay credentials from the database.
2. Forwards the request to the agent-relay HTTP API (e.g. `POST /api/deploy`, `POST /api/rollback`, `GET /api/logs`, `GET /api/preflight`).
3. Records the result in the `deploys` table and updates the app status.

Requests to agent-relay use a 30-second timeout. If the relay is unreachable or returns an error, the deploy is marked as failed and the failure is visible in deploy history.

## Data model

- **Server**: a VPS instance with host, optional SSH key path, relay URL/token, and connection status (`unknown`, `online`, `offline`, `no-relay`).
- **App**: a deployed application per server with health status (`unknown`, `healthy`, `unhealthy`, `deploying`); unique per `(serverId, name)`.
- **Deploy**: deployment history with commit SHAs (before / after), status (`pending`, `running`, `success`, `failed`, `rolled_back`), duration, logs, and trigger source.
- **Audit**: append-only audit trail of user-initiated actions (deploy, rollback, server changes, etc.).
- **Scheduled**: scheduled deploy entries for cron-like recurring deploys.

## Frontend pages

| Route              | Page             | Description                                                                 |
|--------------------|------------------|-----------------------------------------------------------------------------|
| `/`                | Dashboard        | Overview with server count, app count, online status, and recent deploys     |
| `/servers`         | Server List      | Add / remove servers, test relay connections, view status badges             |
| `/servers/[id]`    | App Management   | View apps on a server; deploy, rollback, view logs, run preflight checks     |
| `/deploys`         | Deploy History   | Filterable table of all deployments with status, commit, duration, timestamp |
| `/audit`           | Audit Log        | Filterable audit trail of user actions                                       |
| `/login`           | Login            | Authentication page                                                          |
| `/settings`        | Settings         | Panel configuration and user preferences                                     |

## Why proxy instead of direct browser-to-relay?

Three reasons. First, `relayToken` should never reach the browser: keeping it server-side means a compromised browser session cannot exfiltrate fleet credentials. Second, deploy status and audit logging belong on the backend (next to the database), so a single code path records every deploy regardless of trigger (UI, CI, schedule). Third, CORS and TLS termination are simpler when the relay is only ever called from one well-known origin.
