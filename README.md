# deploy-panel

> **Status: Work in Progress** — This project is under active development. Features listed below are planned, not yet implemented unless marked with a checkmark.

Web-based control panel for managing VPS deployments. Works together with [agent-relay](https://github.com/LanNguyenSi/agent-relay) to provide a visual interface for server and app management.

## What it does

deploy-panel gives you a dashboard to manage your VPS fleet and trigger deployments:

- **Server management** — add VPS servers, test connections, install agent-relay
- **App overview** — see all apps across all servers with health status
- **Deploy triggers** — one-click deploy, rollback, and pre-flight checks
- **Deploy history** — timeline of all deployments with status and logs

## Architecture (target)

```
Browser → Next.js frontend → Hono backend → agent-relay on VPS
                                  │
                               PostgreSQL
```

The panel communicates with agent-relay instances via HTTP API. Initial server setup uses SSH.

## Quick Start

```bash
git clone https://github.com/LanNguyenSi/deploy-panel.git
cd deploy-panel
make setup          # installs deps, starts PostgreSQL, runs Prisma generate + push
make dev            # starts backend (port 3001) + frontend (port 3000)
```

### Prerequisites

- Node.js 20+
- Docker (for PostgreSQL)

### Environment Variables

See [`.env.example`](.env.example) for all variables. Key ones:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | — | Session signing secret (min 16 chars) |
| `PORT` | No | `3001` | Backend port |
| `NEXT_PUBLIC_API_URL` | No | `http://localhost:3001` | API URL for frontend |

## Tech Stack

- **Backend:** Hono + Prisma + PostgreSQL + Zod
- **Frontend:** Next.js 15 + React 19
- Same design system as [agent-tasks](https://github.com/LanNguyenSi/agent-tasks)

## Data Model

- **Server** — VPS instances with SSH and relay connection info
- **App** — deployed applications per server with health status
- **Deploy** — deployment history with commit SHAs, status, duration, and logs

## Roadmap

- [x] Project scaffold (backend + frontend + data model)
- [ ] Server management (add/remove VPS, test connection, install relay)
- [ ] App management (list apps, trigger deploys, view logs)
- [ ] Deploy history timeline
- [ ] Dashboard overview

## Related

- [agent-relay](https://github.com/LanNguyenSi/agent-relay) — VPS daemon that executes deployments

## License

[MIT](LICENSE)
