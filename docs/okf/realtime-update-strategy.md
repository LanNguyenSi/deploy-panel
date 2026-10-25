---
type: overview
title: Realtime update strategy — three coexisting mechanisms, not one
description: backend-to-relay deploy streaming is real SSE parsed manually; backend-to-browser relay provisioning progress (install, re-install, update-relay-image) is SSE-shaped but sent over POST because EventSource only supports GET; everything else (deploy/app status in the browser) is plain interval polling.
tags: [sse, polling, realtime, overview]
timestamp: 2026-10-25T11:23:44Z
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
| backend ↔ relay (deploy) | Real SSE, parsed by hand | The relay streams `event:`/`data:` frames over a plain fetch; `streamDeploy` (`backend/src/lib/stream-deploy.ts:335-368`) reads the response body's `ReadableStream` and splits on `\n`, matching `event: `/`data: ` prefixes itself — no `EventSource`, because the caller is a Node `fetch`, not a browser. |
| backend ↔ browser (relay install, re-install and image-update progress) | SSE-shaped, but sent over POST | `POST /api/servers/install-relay`, `POST /api/servers/:id/install-relay` and `POST /api/servers/:id/update-relay-image` stream via Hono's `streamSSE` (`backend/src/routes/servers.ts:563`, `servers.ts:782#"return streamSSE(c, async (stream) => {"`, `servers.ts:1152#"return streamSSE(c, async (stream) => {"`); the browser side reads them with a hand-rolled `fetch` + `ReadableStream` reader (`sseStream`, `frontend/src/lib/api.ts:208-271`, called for the three routes at `api.ts:277#"sseStream<InstallRelayEvent>"`, `api.ts:324#"sseStream<ReinstallRelayEvent>"` and `api.ts:362#"sseStream<UpdateRelayImageEvent>"`), NOT the browser's native `EventSource`. The reason is stated directly in the frontend's own doc comment (api.ts:195-200): `EventSource` only supports `GET`, and each of these requests carries SSH credentials in a JSON body (plus install options, or an optional relay directory and compose file for an image update), which requires `POST`. |
| browser ↔ backend (deploy/app status elsewhere) | Plain interval polling | No SSE at all. The single-app deploy-progress view polls every 2 seconds while a deploy is in flight (`frontend/src/app/servers/[id]/page.tsx:221-245`, comment: "Fast polling — backend streams steps in real-time" refers to the DB being updated in real time by `stream-deploy.ts`'s step-by-step writes, not to the browser's own transport). After a bulk deploy the same page polls each still-running deploy (first poll at once, then every 3 seconds, at most 40 polls) to fill its "Bulk deploy result" panel (`frontend/src/app/servers/[id]/page.tsx:106-127`, constants in `frontend/src/lib/bulk-deploy.ts`). The dashboard and deploy-history views poll every 15 seconds (`frontend/src/app/page.tsx:31`, `frontend/src/app/deploys/page.tsx:44`); the server-list view polls every 30 seconds (`frontend/src/app/servers/page.tsx:72`). |

The two SSE mechanisms are NOT the same connection relayed through: the backend terminates the relay's SSE stream, writes step-by-step progress into the `Deploy.log` column as it goes (`stream-deploy.ts:444-448`), and browsers watching deploy progress see that via 2-second polling, not by riding the relay's own stream. The only places a browser consumes a live SSE-shaped stream from the backend are the three relay provisioning flows (install, re-install, update-relay-image), all read through `sseStream`, which is also why the POST workaround is needed.

## What breaks it

- Assuming `EventSource` is usable anywhere in this codebase for backend-to-browser streaming: the three existing uses need `POST`, so it deliberately isn't used; a future GET-only stream endpoint could use it, but none does today.
- Treating the browser's 2-second poll interval on the single-app view as itself a "streaming" connection — it is polling a DB row that `stream-deploy.ts` happens to update quickly, not a persistent connection.
