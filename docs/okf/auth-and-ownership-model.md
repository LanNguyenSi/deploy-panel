---
type: invariant
title: Auth and ownership model — three credential shapes, one actor context
description: requireAuth resolves API key / PANEL_TOKEN / session cookie into a single { userId, isAdmin } actor context that lib/ownership.ts uses to gate every server-scoped route; admin-shared servers (userId = null) are invisible to non-admin broker actors by design, and requirePanelAuth carves API-key auth out of the api-keys management routes.
tags: [auth, authz, ownership, security]
timestamp: 2026-07-16T05:46:15Z
sources:
  - backend/src/middleware/auth.ts
  - backend/src/lib/ownership.ts
  - backend/src/config/index.ts
  - backend/src/routes/api-keys.ts
  - backend/src/routes/auth.ts
  - backend/prisma/schema.prisma
  - docs/configuration.md
---

## One middleware, one actor context

One middleware, `requireAuth` (`backend/src/middleware/auth.ts:33-104`), resolves every one of the THREE credential shapes deploy-panel accepts into the ownership actor context `isAdmin` and `userId` (it also sets `authType` and `apiKeyName`; the `requirePanelAuth` gate below reads `authType`), and every ownership-aware route reads only `isAdmin` and `userId` (`getActorContext`, `backend/src/lib/ownership.ts:29-36`) — never the raw credential. The three shapes:

1. **`dp_`-prefixed API key** (Bearer). Hashed and looked up in `ApiKey` (auth.ts:51-68). If the row has a `userId` FK, the actor is non-admin and scoped to that user (`isAdmin: false`, `userId` set). If `userId` is null — a legacy admin-created key — the actor is admin (`isAdmin: true`, no `userId`).
2. **`PANEL_TOKEN` bearer** (auth.ts:71-76) or the legacy `panel_session` cookie carrying the raw token (auth.ts:79-88). Both set `isAdmin: true` with no `userId`.
3. **`user_session` cookie** from native GitHub OAuth (auth.ts:90-101, `readUserSessionCookie` + `validateSession`). Always non-admin, `userId` from the `Session` row.

With no `PANEL_TOKEN` configured, `requireAuth` rejects every request with 500 in production, but in development falls through as admin (auth.ts:34-43) — a dev-only convenience, not a security boundary.

## Where it's enforced

`lib/ownership.ts` is the single place that turns `{ userId, isAdmin }` into a Prisma filter or a direct ownership check, and every server-scoped route (servers, apps, deploys, env vars, schedules) goes through it rather than re-deriving access inline:

- `serverOwnershipWhere` (ownership.ts:42-53) — admin gets the base `where` unfiltered; non-admin gets `{ userId: actor.userId }` appended; a non-admin actor with no `userId` (misconfiguration) gets a where that matches nothing (`id: "__no_access__"`), never a silent fall-through to "see all".
- `findOwnedServer` / `findOwnedServerByHost` / `findOwnedServerByIdOrName` (ownership.ts:60-98) — admin sees any row; non-admin sees a row only if `server.userId === actor.userId`. All three return `null` (not a 403) on a foreign or missing server, so callers render a uniform 404 that doesn't leak existence to a probing non-admin.

**Non-obvious rule: admin-shared servers are invisible to non-admin broker actors.** `Server.userId = null` means "admin-shared, part of the existing panel-managed fleet" (schema.prisma:53-59, ownership.ts:1-16 doc comment). The ownership checks above test `server.userId && server.userId === actor.userId` — the `server.userId &&` guard means a null-owned server NEVER matches a non-admin actor, regardless of their `userId`. This is deliberate: the broker path (`POST /api/auth/register-from-project-pilot`, routes/auth.ts:221-335) provisions per-user resources for a new identity; it is not a grant of access to servers an admin already manages via `PANEL_TOKEN`. A non-admin actor's fleet is exactly the servers created under their own `userId` (see `install-relay`'s `userId: actor.isAdmin ? null : actor.userId`, routes/servers.ts:610).

**`requirePanelAuth` carves API-key auth out of key management.** Mounted after `requireAuth` on `/api/api-keys/*` only (`app.ts:63-65`), it 403s any request whose `authType` is `"api_key"` (auth.ts:110-116) — a `dp_...` key can deploy, read servers, etc., but cannot list, create, or revoke API keys. Only panel-token or session auth can manage keys. `routes/api-keys.ts` itself does no ownership filtering (`GET /` lists ALL keys, `DELETE /:id` deletes by bare id) — it relies entirely on `requirePanelAuth` restricting the route to admin-equivalent credentials, since `authType` is only ever `"panel"` or `"session"` past that gate, both of which set `isAdmin: true`.

## What breaks it

- Reading a route's own credential type instead of `getActorContext`'s `{ userId, isAdmin }` — any new ownership check must go through `lib/ownership.ts`, not re-derive `isAdmin`/`userId` from `authType` or the raw token.
- Dropping the `server.userId &&` guard in any of the three `findOwnedServer*` helpers — that is the only thing keeping admin-shared (`userId = null`) servers out of a non-admin actor's fleet.
- Mounting a new `/api/api-keys` route without `requirePanelAuth` — `routes/api-keys.ts` has no ownership filtering of its own and depends entirely on that gate to stay admin-only.
- Treating `PANEL_TOKEN`-unset dev fallback (`isAdmin: true`, auth.ts:40-42) as anything but a local-dev convenience; it never fires when `NODE_ENV === "production"` (auth.ts:36-39) and must not be relied on as a security boundary elsewhere.
