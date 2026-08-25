---
type: overview
title: Realtime update strategy — three coexisting mechanisms, not one
description: backend-to-relay deploy streaming is real SSE parsed manually; backend-to-browser install-relay progress is SSE-shaped but sent over POST because EventSource only supports GET; everything else (deploy/app status in the browser) is plain interval polling.
tags: [sse, polling, realtime, overview]
timestamp: 2026-08-25T13:45:00Z
sources:
  - backend/src/lib/stream-deploy.ts
  - backend/src/routes/servers.ts
  - frontend/src/lib/api.ts
  - frontend/src/app/servers/[id]/page.tsx
  - frontend/src/app/page.tsx
  - frontend/src/app/deploys/page.tsx
  - frontend/src/app/servers/page.tsx
---

deploy-panel has three separate real-time mechanisms in play, distinguished by which two parties are talking and why:

| Link | Mechanism | Why |
|---|---|---|
| backend ↔ relay (deploy) | Real SSE, parsed by hand | The relay streams `event:`/`data:` frames over a plain fetch; `streamDeploy` (`backend/src/lib/stream-deploy.ts:235-268`) reads the response body's `ReadableStream` and splits on `\n`, matching `event: `/`data: ` prefixes itself — no `EventSource`, because the caller is a Node `fetch`, not a browser. |
| backend ↔ browser (install-relay progress) | SSE-shaped, but sent over POST | `POST /api/servers/install-relay` streams via Hono's `streamSSE` (`backend/src/routes/servers.ts:524`); the browser side reads it with a hand-rolled `fetch` + `ReadableStream` reader (`sseStream`, `frontend/src/lib/api.ts:197-260`), NOT the browser's native `EventSource`. The reason is stated directly in the frontend's own doc comment (api.ts:184-189): `EventSource` only supports `GET`, and the install/re-install request body (host, SSH credentials, install options) requires `POST`. |
| browser ↔ backend (deploy/app status elsewhere) | Plain interval polling | No SSE at all. The single-app deploy-progress view polls every 2 seconds while a deploy is in flight (`frontend/src/app/servers/[id]/page.tsx:140-161`, comment: "Fast polling — backend streams steps in real-time" refers to the DB being updated in real time by `stream-deploy.ts`'s step-by-step writes, not to the browser's own transport). The dashboard and deploy-history views poll every 15 seconds (`frontend/src/app/page.tsx:31`, `frontend/src/app/deploys/page.tsx:44`); the server-list view polls every 30 seconds (`frontend/src/app/servers/page.tsx:42`). |

The two SSE mechanisms are NOT the same connection relayed through: the backend terminates the relay's SSE stream, writes step-by-step progress into the `Deploy.log` column as it goes (`stream-deploy.ts:342-346`), and browsers watching deploy progress see that via 2-second polling, not by riding the relay's own stream. The only place a browser directly consumes a live SSE-shaped stream from the backend is the install-relay wizard's progress view, which is also the only place the POST-over-EventSource workaround is needed.

## What breaks it

- Assuming `EventSource` is usable anywhere in this codebase for backend-to-browser streaming — the one existing use needs `POST`, so it deliberately isn't used; a future GET-only stream endpoint could use it, but none does today.
- Treating the browser's 2-second poll interval on the single-app view as itself a "streaming" connection — it is polling a DB row that `stream-deploy.ts` happens to update quickly, not a persistent connection.
