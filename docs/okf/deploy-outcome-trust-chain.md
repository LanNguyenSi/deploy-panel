---
type: invariant
title: Deploy-outcome trust chain — the relay's "success" is never taken at face value
description: finalizeDeploy is the single choke point for all three relay outcome shapes (SSE done, JSON fallback, stream-ended-without-done); every relay-reported success runs verifyDeployHealth and can be downgraded to failed, while connection-lost recovery uses the gate's stricter fail-closed mode and startup recovery applies the same fail-closed posture via a relay preflight — the mechanism behind the self-deploy-502-but-succeeds quirk.
tags: [deploy, health-gate, recovery, invariant]
timestamp: 2026-08-17T14:45:00Z
sources:
  - backend/src/lib/stream-deploy.ts
  - backend/src/lib/post-deploy-gate.ts
  - backend/src/lib/deploy-recovery.ts
  - backend/src/lib/startup.ts
  - backend/src/lib/scheduler.ts
---

## Relay success is a claim, not a verdict

No deploy is written to the database as `status: "success"` on the relay's word alone. `finalizeDeploy` (`backend/src/lib/stream-deploy.ts:32-79`) is the single choke point every relay-reported outcome funnels through, and it re-verifies before trusting a reported success.

`streamDeploy` (stream-deploy.ts:85-236) hands `finalizeDeploy` exactly three shapes of relay outcome, all converging on the same function:

1. **SSE `done` event** (`handleEvent`, stream-deploy.ts:259-271) — the relay finished streaming and reported `success`/`failure` explicitly.
2. **JSON fallback** (stream-deploy.ts:149-189) — the relay doesn't support streaming and returned a single JSON body instead; `success` is derived from `data.result.success` or `data.deploy.status`.
3. **Stream ended without a `done` event** (stream-deploy.ts:217-230) — the connection closed cleanly but no terminal event arrived; success is inferred from whether every accumulated step reports `"success"` or `"skipped"`.

Whenever any of these three report `relaySuccess: true`, `finalizeDeploy` runs `verifyDeployHealth` (`backend/src/lib/post-deploy-gate.ts`, `verifyDeployHealth` near the end of the file) — container run-state via `docker compose ps` plus a public-route probe — and DOWNGRADES `success` to `false` if the verdict is unhealthy (stream-deploy.ts:43-59). A relay-reported failure is written straight through with no second-guessing (the doc comment at stream-deploy.ts:22-30 states this explicitly). The gate exists because the relay's own internal health probe stops at the first container that answers, so a crashlooping sibling service, or a broken Traefik route invisible from inside the container network, can hide behind a `docker compose up` exit code of 0 (post-deploy-gate.ts:9-21).

## Fail-closed vs. fail-open: two calling conventions for the same gate

`verifyDeployHealth` takes a `requireHealthyEvidence` flag (doc comment on `VerifyDeployHealthOptions` in post-deploy-gate.ts) that inverts its default posture:

- **Default / optimistic (`false`)**, used by `finalizeDeploy` on the relay-success path: the absence of a bad signal is enough — an unreachable relay or an empty `docker compose ps` does not, by itself, fail the gate, because a real success signal already exists. Since 2026-08-17 this is qualified for Docker healthchecks that have not RESOLVED yet: a service with `health: "starting"` is neither offender nor clean evidence — the gate keeps polling within a bounded extension (`pendingExtraAttempts`, default 9 extra polls, so the optimistic window can grow from the base 4 × 5s ≈ 15s up to ~60s), an unreadable poll while something was "starting" carries the watch forward instead of passing, and if the window exhausts still-"starting" the deploy passes optimistically WITH a `notes` entry naming the unresolved service(s) and any offender seen earlier in the window.
- **Strict / fail-closed (`true`)**, used by connection-lost recovery below (startup recovery shares the posture via a lighter relay preflight, not this gate): there is NO success signal to trust, so only a POSITIVE confirmation (≥1 running service, none unhealthy, none still `"starting"`, and the route if set) counts; an unreachable relay, nothing running, or an unresolved healthcheck keeps the deploy `failed`. Consequence: a healthy-but-slow healthcheck (long `start_period`, Docker's default 30s interval) can consume the recovery window and be recorded failed — the reason string names the still-starting services (current fleet healthchecks resolve at 5-10s intervals, well inside the window).

**Connection-lost recovery** (`backend/src/lib/deploy-recovery.ts`, `recoverBrokenDeploy`) is invoked from `streamDeploy`'s catch block (stream-deploy.ts:231-235) whenever the relay fetch/stream throws. It runs `verifyDeployHealth` with `requireHealthyEvidence: true` over 5 polls × 12s (deploy-recovery.ts:4-9) — containers are typically mid-recreate when a stream drops, so it deliberately waits before deciding. (Note: since the pending-health change the OPTIMISTIC gate's worst-case window, ~60s with the pending extension, is about the same length — the recovery path is stricter in posture, no longer simply "longer".)

**Startup stuck-deploy recovery** (`backend/src/lib/startup.ts`, `recoverStuckDeploys`) handles deploys still `status: "running"` more than 2 minutes after creation — the shape left behind by a self-deploy that killed the backend process mid-response. It uses a lighter relay `preflight` check rather than the full gate, but the same fail-closed posture: relay-unreachable or preflight-not-passed both resolve to `"interrupted"`, never `"success"` (startup.ts:36-50).

## This is the mechanism behind the self-deploy-502-but-succeeds quirk

Deploying deploy-panel's own backend kills the backend process mid-HTTP-response, so the browser/CI client sees a 502 (or a dropped connection) even though the deploy itself proceeds correctly on the relay side. The 502 is a client-side artifact of the connection dying, not a deploy failure: `streamDeploy`'s catch block fires `recoverBrokenDeploy`, which fail-closed re-verifies health once the new backend process is back up, and confirms the deploy as `success` if the app is genuinely healthy. If the backend restarts before recovery finishes for an in-flight deploy, `recoverStuckDeploys` runs on the NEXT boot and does the equivalent check via `preflight`. Either path can turn a 502-shaped client experience into a correctly-recorded `success` — this is expected behavior, not a bug: verify via `GET /api/deploys` or the DB rather than trusting the client-observed HTTP status of a self-deploy request.

## Scheduled deploys share the exact same path

`checkScheduled` (`backend/src/lib/scheduler.ts:13-78`) calls `streamDeploy` directly (scheduler.ts:68-76) rather than hitting the relay via a second, divergent call. The comment at scheduler.ts:58-67 documents why: an earlier version called the relay directly from the scheduler and skipped BOTH the pre-deploy secret provisioning and the required-env hard-fail gate, reproducing the exact `METRICS_API_TOKEN`-missing incident for scheduled deploys specifically. Routing scheduled deploys through `streamDeploy` means they get the same secret provisioning, the same three-shape relay handling, and the same trust chain described above — one implementation, not two.

## What breaks it

- Writing `deploy.status = "success"` anywhere outside `finalizeDeploy` on a relay-reported success — that bypasses `verifyDeployHealth` entirely and reopens the exact crashloop-as-healthy hole the gate exists to close.
- Adding a fourth relay-response shape (e.g. a new streaming protocol) that doesn't funnel through `finalizeDeploy` — it would silently skip the health gate for that shape alone.
- Flipping `requireHealthyEvidence` between the connection-lost recovery path and the post-success path, or defaulting it to `true` for the post-success path — the optimistic default there is what keeps a transient relay blip after a genuinely successful deploy from turning it red.
- Calling the relay directly for any new deploy trigger (a second scheduler-style call site) instead of `streamDeploy` — that was the exact scheduler bug scheduler.ts:58-67 documents, and it silently drops secret provisioning + the required-env gate, not just the health gate.
