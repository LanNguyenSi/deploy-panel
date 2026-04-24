# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-04-24

**Headline: fleet onboarding + lifecycle. Fresh VPS → online relay in
a wizard flow; re-install + image-update without SSH; per-user data
isolation + native GitHub OAuth; audit-log attribution. This release
also hardens the install path with host-key pinning, a probe step,
and a single coordinated status-write surface.**

### Added — Onboarding & fleet lifecycle

- **Server onboarding wizard** (PR #63). `POST /api/servers/install-relay`
  runs `agent-relay/install.sh` on a fresh VPS over ephemeral SSH,
  streams the installer output as SSE, parses URL + Token from the
  output, and creates the Server row on success. Admin-only, creds
  zeroed after connect, no DB write on failure.
- **Mode-aware wizard + pre-install VPS probe** (PR #64). New
  `POST /api/servers/probe-vps` runs a diagnostic SSH command against
  the target (ports 80/443 + `docker ps` + network inspect) and
  suggests `greenfield` / `existing-traefik` / `port-only` based on
  what's already running. UI dropdown pre-fills from the probe;
  advanced fields (TRAEFIK_NETWORK / TRAEFIK_CERTRESOLVER /
  RELAY_BIND) collapse behind a toggle. Captures the host-key
  SHA-256 fingerprint for MITM pinning.
- **Re-install** (PR #65). `POST /api/servers/:id/install-relay`
  re-runs install.sh against an existing server, pinning the stored
  host-key fingerprint (refuses on mismatch with a "was the VPS
  rebuilt?" message before touching docker). Preserves the existing
  AUTH_TOKEN by default; opt-in `rotateToken=true` wipes the VPS
  `.env` to force fresh generation. Surfaces `tokenDiverged` on the
  done event when the VPS emitted a different token than DB without
  explicit rotation.
- **Update Relay Image** (PR #67). `POST /api/servers/:id/update-relay-image`
  runs `docker compose pull && docker compose up -d` on an
  already-installed relay. No install.sh, no Traefik fiddling —
  typical 10–30s instead of the re-install's 2–5min. Streams SSE
  log; flips status to `online` after post-update /health probe
  succeeds.
- **Custom install path + compose file support** (PR #68). New
  `Server.relayDir` + `Server.relayComposeFile` columns. Re-install
  and update-image resolve effective dir/file via body override →
  stored value → installer default. Fixes the real-world case where
  a relay was installed manually at `/root/git/agent-relay` with
  `docker-compose.prod.yml` (Traefik labels + custom mount).
  Strict zod validation before shell-templating.

### Added — Auth & data model

- **Native GitHub OAuth login** (PR #60, #61). Operators can sign
  into the dashboard with a GitHub identity directly (no panel-token
  sharing). Optional allowlist via `ALLOWED_GITHUB_LOGINS` for the
  standalone deploy.
- **Identity broker registration** (PR #56, #57, #58). External
  broker can register users + mint per-user API keys
  (`dp_user_*`). Optional GitHub-login allowlist gates who the
  broker can enrol.
- **Per-user data isolation** (PR #59). `Server.userId` column +
  `findOwnedServer` / `serverOwnershipWhere` helpers gate every
  server-scoped read + mutation. Admin actors see the full fleet;
  non-admin actors only their own rows. Cascades through App /
  Deploy / EnvVarChange / ScheduledDeploy via `serverId`.
- **Audit-log user attribution** (PR #62). Audit entries now carry
  the actor's `userId` + type. `/api/audit` scopes per user for
  non-admin viewers.

### Added — Safety & observability

- **Coordinated status writes** (PR #70). New
  `services/server-status.ts` routes every `Server.status` mutation
  through `setServerStatus({source: "action" | "probe"})`. Probe
  writes skip when a mutation is in flight for that server (but
  still refresh `lastSeenAt`) so a scheduled `/test` during an
  update-image's post-probe retry loop doesn't overwrite the
  action's authoritative `online` with a transient `offline`.
- **Full Step-7 fixture tests** (PR #69). Four byte-for-byte
  install.sh v0.2.0 output fixtures (greenfield / existing-traefik
  / port-only public / port-only loopback) pinned against
  `parseInstallOutput`. Catches installer-output drift before it
  surfaces as silent token_not_found in a wizard run.

### Fixed

- **ssh-executor ESM crash** (PR #66). `require("node:crypto")` in
  the hostVerifier callback threw `require is not defined` on first
  SSH handshake in production (vitest shims it; Node ESM does not).
  Moved to top-level `import { createHash } from "node:crypto"` and
  added a source-lint regex guard in the test suite so future
  `require(…)` regressions fail at CI time.

### Migration notes

- **Prisma migrations**: `20260424_add_server_relay_fingerprint`
  adds `hostKeySha256` + `relayMode`;
  `20260424_add_server_relay_dir` adds `relayDir` +
  `relayComposeFile`. All four columns are nullable and idempotent
  under the prod `prisma db push` entrypoint — no data backfill
  required. Legacy rows carry `null` for all four; re-install /
  update-image TOFU-and-capture on first successful run.
- **New env surface on the install-relay route**: `relayMode`,
  `traefikNetwork`, `traefikCertResolver`, `relayBind`, `relayDir`,
  `relayComposeFile`. All optional; all zod-validated.
- **Audit log format**: entries now include `userId` — existing
  consumers pulling via `/api/audit` see an extra column; response
  shape is a superset of v0.1.0.

## [0.1.0] - 2026-04-18

**Headline: First tagged release of deploy-panel — the web control
plane that turns an `agent-relay` fleet into a visual, auditable
deploy surface. Ships a Next.js 15 dashboard, a Hono + Prisma
backend, a v1 REST API for CI/CD, an MCP server for AI agents, a
reusable GitHub Action, and a smoke-check job that catches the
class of runtime regression that paged us on 2026-04-12.**

This is the line in the sand: from v0.1.0 onward, the v1 REST
contract, the `dp_*` API-key format, the MCP tool surface, the
GitHub Action inputs, and the env-var / Docker-Compose deploy
shape all follow SemVer. Operators on earlier snapshots must
follow the migration notes below before pulling the tagged image.

### Added

#### Dashboard (Next.js 15)

- Complete UI pass: new design system, sidebar navigation with a
  distinct identity from depsight / agent-tasks, toast
  notifications, confirm dialogs, `PromptDialog` + `ScheduleDialog`
  (no more native browser prompts), polished login flow.
- Dashboard view with live fleet overview: online / offline
  servers, app totals, recent deploys.
- Server detail page with health sync, live CPU / RAM / Disk bars
  (per server), app list with tag filters
  (`production` / `development` / `ignored`).
- App card: live URL field, click-through to the running app, pin
  apps for quick-deploy from the dashboard.
- Deploy history timeline: filterable, paginated, with deploy
  comparison (expandable rows showing commit diff), status, commit
  SHA, duration. SVG sparkline chart of deploy-duration trends.
- Live deploy log viewer with step-by-step output streamed over
  SSE.
- Global `/scheduled` page — fleet-wide view of scheduled deploys.
- Bulk Deploy — trigger multiple apps with one click.
- Browser notifications when a deploy completes.
- Settings page with API-key management UI.
- App `.env` management in the panel UI (create / edit / reveal,
  gated by auth).
- Dashboard and deploy-history auto-refresh every 15s.

#### Backend (Hono + Prisma)

- PostgreSQL-backed server / app / deploy / audit-log metadata
  (Prisma schema).
- Relay proxy layer: looks up `relayUrl` + `relayToken` per
  server, forwards deploy / rollback / logs / preflight requests
  to the agent-relay instance on that VPS.
- Async deploys with optimistic UI + polling, SSE live step
  streaming as the preferred path, graceful polling fallback when
  SSE is unavailable.
- Deploy recovery: reconciles stuck `running` deploys on startup
  and when the relay connection breaks mid-deploy.
- Preflight recovery gate — checks critical preflight only, so
  non-critical fails no longer block re-entry to deploy.
- Rollback path: `apps.ts` rollback failures now hand off to
  `recoverBrokenDeploy`.
- Audit log: every deploy, server-edit, and API-key action is
  recorded and queryable from the UI.

#### v1 REST API (`/api/v1`)

- `/api/v1/deploys`, rollback, logs — REST endpoints designed for
  CI/CD integration.
- Offset pagination + total count on the deploy-history endpoint
  so the paginated UI has stable navigation.
- v1 deploy endpoint uses the SSE streaming path for live step
  updates.
- API keys use the `dp_*` prefix and are minted from the
  dashboard's Settings page.

#### MCP server

- `mcp/` subpackage (`@deploy-panel/mcp`) — Model Context
  Protocol surface so AI agents can drive deploys, rollbacks, and
  status queries as tools.

#### GitHub Action

- `action/action.yml` — reusable composite action
  (`Deploy Panel — Deploy`) that runs a deploy via the v1 API
  after a merge. Inputs: `url`, `api-key`, `server`, `app`,
  `preflight`. Branded icon + color for the marketplace listing.

#### Ops / reliability

- `scripts/smoke-check.sh` + `ci.yml` `smoke` job: spins up db +
  backend from the PR's code against a disposable `.env`, waits
  for `/api/health`, runs a real DB-backed query path, and tears
  down. Guards against silent Prisma-client-vs-live-schema drift
  — the exact regression class behind the 2026-04-12 production
  incident.
- `ci.yml` matrix: backend typecheck (with `prisma generate`),
  frontend typecheck, frontend build, `docker compose build`,
  smoke (gated on the cheap static jobs). Now reusable via
  `workflow_call` for the release workflow.
- `docker-compose.ci.yml` overlay isolates the CI stack from the
  prod compose.
- Backend entrypoint runs `prisma db push` with retries before
  Hono binds; failures are loud (no silent swallow) — earlier
  versions hid schema mismatches at startup.
- PANEL_TOKEN is wired into the backend container in prod compose
  (earlier versions forgot to propagate it and the backend
  silently ran without auth).

#### Scheduled deploys

- Scheduled Deploys feature — plan a deploy for later with
  `ScheduleDialog`.
- `/scheduled` page for a fleet-wide view.

#### Repo + release engineering

- `.github/workflows/release.yml` — tag-driven (`v*`) GitHub
  Release flow that calls CI as a reusable workflow and publishes
  the matching CHANGELOG section as the release body.
- `CHANGELOG.md`, this file.
- `.relay.yml` so deploy-panel can deploy itself via agent-relay.
- MIT license. Root `package.json` is a npm-workspaces root; the
  shipping artifacts are `backend` (`deploy-panel-backend`),
  `frontend` (`deploy-panel-frontend`), and `mcp`
  (`@deploy-panel/mcp`).

### Changed

- Authentication: all API endpoints now require a valid panel
  token (#8). Pre-v0.1.0 `/api/*` routes ran unauthenticated.
- Relay proxy paths aligned with agent-relay's API shape; timeout
  widened to 5 min (deploys take time).
- Frontend healthcheck uses Node `fetch` (wget not available to
  the non-root runtime user).
- Full `node_modules` is copied for Next.js `standalone` output
  in the workspace monorepo — previous builds were missing
  modules at runtime.
- Alpine backend image includes `openssl`; frontend standalone
  `CMD` path corrected; Prisma `musl` binary target added.
- Null-tagged apps are included in the default list (not only
  non-ignored), so apps that predate the tag system still render.
- UI deploys force `force=true` to match the relay's preflight
  override contract.
- Content area widened with centered layout on large screens.
- Frontend standalone build CMD corrected.

### Fixed

- Correctly parse nested relay deploy responses; unions cast at
  the narrowing boundary.
- Stream deploy: handle JSON response from the relay in
  `streamDeploy`.
- v1 deploy endpoint now uses `streamDeploy` for live step
  updates (was blocking).
- `recoverBrokenDeploy` is invoked on rollback failures instead
  of leaving deploys stuck in `running`.
- Backend entrypoint Prisma `db push` uses the correct schema
  path and exits non-zero on failure (#45).
- Dependabot sweep: hono, `@hono/node-server`, follow-redirects,
  dompurify, next. Hono bump in `mcp/` subpackage patches the JSX
  HTML-injection CVE (#49, #52, #53).

### Migration notes

- **Auth is mandatory now.** Any integrations that previously
  hit `/api/*` without a token must be re-minted with a `dp_*`
  API key from the Settings page.
- **`PANEL_TOKEN`** is required in prod compose and must be
  propagated to the backend container. If you copied an earlier
  `docker-compose.prod.yml` that missed it, update before
  redeploying.
- **Schema migrations**: the backend entrypoint runs
  `prisma db push` against `DATABASE_URL` on startup. Existing
  installs that predate the smoke-check era should take a logical
  dump before the first v0.1.0 redeploy in case ad-hoc schema
  drift accumulated.
- **GitHub Action**: if you wired an earlier snapshot into a
  workflow, re-point to the `v0.1.0` tag (or a SHA) so downstream
  CI pins a stable input surface.
- **Release discipline**: `v0.1.0` is the first tagged release.
  The `0.1.0` version numbers already carried in
  `backend/package.json`, `frontend/package.json`, and
  `mcp/package.json` are now authoritative.
