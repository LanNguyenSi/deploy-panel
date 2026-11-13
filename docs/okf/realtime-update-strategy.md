---
type: overview
title: Realtime update strategy — three coexisting mechanisms, not one
description: backend-to-relay deploy streaming is real SSE parsed manually; backend-to-browser relay provisioning progress (install, re-install, update-relay-image) is SSE-shaped but sent over POST because EventSource only supports GET; everything else (deploy/app status in the browser) is plain interval polling.
tags: [sse, polling, realtime, overview]
timestamp: 2026-11-12T12:36:18Z
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
| backend ↔ relay (deploy) | Real SSE, parsed by hand | The relay streams `event:`/`data:` frames over a plain fetch; `streamDeploy` (`backend/src/lib/stream-deploy.ts:460-506`) reads the response body's `ReadableStream` and splits on `\n`, matching `event: `/`data: ` prefixes itself — no `EventSource`, because the caller is a Node `fetch`, not a browser. |
| backend ↔ browser (relay install, re-install and image-update progress) | SSE-shaped, but sent over POST | `POST /api/servers/install-relay`, `POST /api/servers/:id/install-relay` and `POST /api/servers/:id/update-relay-image` stream via Hono's `streamSSE` (`backend/src/routes/servers.ts:623`, `servers.ts:865#"return streamSSE(c, async (stream) => {"`, `servers.ts:1265#"return streamSSE(c, async (stream) => {"`); the browser side reads them with a hand-rolled `fetch` + `ReadableStream` reader (`sseStream`, `frontend/src/lib/api.ts:221-284`, called for the three routes at `api.ts:290#"sseStream<InstallRelayEvent>"`, `api.ts:337#"sseStream<ReinstallRelayEvent>"` and `api.ts:375#"sseStream<UpdateRelayImageEvent>"`), NOT the browser's native `EventSource`. The reason is stated directly in the frontend's own doc comment (api.ts:208-213): `EventSource` only supports `GET`, and each of these requests carries SSH credentials in a JSON body (plus install options, or an optional relay directory and compose file for an image update), which requires `POST`. |
| browser ↔ backend (deploy/app status elsewhere) | Plain interval polling | No SSE at all. The single-app deploy-progress view polls while a deploy is in flight with a self-rescheduling `setTimeout` chain (one chain, status and log per app, so deploys of different apps can run at the same time; unmount stops every chain): 2 seconds between polls while polls succeed (`stream-deploy.ts` updates the DB row step by step in real time; the browser's own transport stays plain polling), the delay doubles after each failed poll (2 s, 4 s, 8 s, ...) capped at 15 s and resets to 2 s after the next successful poll, because a poll error is transient (a panel self-deploy takes the panel's own backend down, so every poll inside the restart window fails), and 15 minutes after the deploy POST the bound stops the chain, the page says the deploy status is unknown until a reload, and the app badge stops claiming deploying even when that reload fails (`frontend/src/app/servers/[id]/page.tsx:281-332`, constants and their comment at `page.tsx:27-34`, unmount cleanup and poll-arm effect at `page.tsx:230-263`). After a bulk deploy the same page polls each still-running deploy (first poll at once, then every 3 seconds, at most 200 polls, about ten minutes; a streamed deploy has no total stream timeout now, only silence windows) to fill its "Bulk deploy result" panel; an entry still running when polling stops shows as "Unknown" with a pointer to the deploy history, not as "Running" (`frontend/src/app/servers/[id]/page.tsx:118-144`, constants in `frontend/src/lib/bulk-deploy.ts`). The dashboard and deploy-history views poll every 15 seconds (`frontend/src/app/page.tsx:35`, `frontend/src/app/deploys/page.tsx:45-46`); the server-list view polls every 30 seconds (`frontend/src/app/servers/page.tsx:74`). |

The two SSE mechanisms are NOT the same connection relayed through: the backend terminates the relay's SSE stream, writes step-by-step progress into the `Deploy.log` column as it goes (`stream-deploy.ts:591-595`), and browsers watching deploy progress see that via the 2-second-based poll chain above, not by riding the relay's own stream. The only places a browser consumes a live SSE-shaped stream from the backend are the three relay provisioning flows (install, re-install, update-relay-image), all read through `sseStream`, which is also why the POST workaround is needed.

## What breaks it

- Assuming `EventSource` is usable anywhere in this codebase for backend-to-browser streaming: the three existing uses need `POST`, so it deliberately isn't used; a future GET-only stream endpoint could use it, but none does today.
- Treating the browser's poll chain on the single-app view as itself a "streaming" connection — it is polling a DB row that `stream-deploy.ts` happens to update quickly, not a persistent connection.
- Treating a failed deploy-status poll in the single-app view as the deploy's outcome: a panel self-deploy takes the panel's own backend down mid-deploy, so polls fail for a while on a deploy that succeeds; the chain backs off and keeps polling, and only the deploy row's own status (or the 15-minute bound) settles what the page shows.
