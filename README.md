# deploy-panel

> **Status: Work in Progress**

Web-based control panel for managing VPS deployments. Works together with [agent-relay](https://github.com/LanNguyenSi/agent-relay) to provide a visual interface for server and app management.

## What it does

deploy-panel gives you a dashboard to manage your VPS fleet and trigger deployments:

- **Server management** — add VPS servers, test connections, install agent-relay
- **App overview** — see all apps across all servers with health status
- **Deploy triggers** — one-click deploy, rollback, and pre-flight checks
- **Deploy history** — timeline of all deployments with status and logs

## Architecture

```
[deploy-panel]
    │
    ├── Servers Page ──── SSH ──── [VPS: install relay]
    │
    ├── Apps Page ──── HTTP API ──── [agent-relay on VPS]
    │                                    ├── deploy
    │                                    ├── rollback
    │                                    ├── status
    │                                    └── logs
    │
    └── Deploy History
```

## Tech Stack

- **Backend:** Hono + Prisma + PostgreSQL
- **Frontend:** Next.js 15 + React 19
- Same stack and design system as [agent-tasks](https://github.com/LanNguyenSi/agent-tasks)

## Roadmap

- [x] Project scaffold
- [ ] Server management (add/remove VPS, test connection, install relay)
- [ ] App management (list apps, trigger deploys, view logs)
- [ ] Deploy history timeline
- [ ] Dashboard overview

## Related

- [agent-relay](https://github.com/LanNguyenSi/agent-relay) — VPS daemon that executes deployments

## License

MIT
