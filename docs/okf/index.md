# Knowledge bundle index

Curated OKF knowledge bundle for the deploy-panel repo: cross-file
semantics, invariants, and non-obvious mechanisms that no single source
file or existing doc states on its own. The mature references one level up
(`docs/`: architecture.md, configuration.md, api.md) stay authoritative for
their areas; these docs deliberately do not duplicate them.

## Overview

- [Realtime update strategy](realtime-update-strategy.md), three coexisting
  mechanisms for "live" updates — real SSE (backend to relay), SSE-over-POST
  (backend to browser, because `EventSource` only supports GET), and plain
  interval polling (everything else) — and why each one is what it is.
- [Schema migrations mechanism](schema-migrations-mechanism.md), pointer to
  the authoritative `backend/prisma/migrations/README.md`: migration.sql
  files are documentation only, both the Docker entrypoint and local dev
  actually apply the schema via `prisma db push`.
- [App secrets config footgun](app-secrets-config-footgun.md), pointer to
  `docs/configuration.md#app-secrets` and `docs/api.md`, plus the one thing
  neither states: why `lib/secret-crypto.ts` reads `process.env` directly
  instead of importing `config/index.ts`.

## Modules

- [VPS onboarding and relay provisioning](vps-onboarding-relay-provisioning.md),
  the TOFU-then-pin host-key model, the SSRF guard and rate limit that apply
  only to non-admin actors, the persisted install metadata that keeps
  re-install/update-image from clobbering hand-customized setups, and the
  per-server/per-actor concurrency locks.

## Invariants

- [Auth and ownership model](auth-and-ownership-model.md), the three
  credential shapes `requireAuth` resolves into one `{ userId, isAdmin }`
  actor context, why admin-shared servers are invisible to non-admin broker
  actors, and the `requirePanelAuth` carve-out on the API-key management
  routes.
- [Deploy-outcome trust chain](deploy-outcome-trust-chain.md), why a
  relay-reported deploy success is never trusted at face value, the single
  `finalizeDeploy` choke point for all three relay response shapes, the
  fail-open vs. fail-closed calling conventions of the post-deploy health
  gate, and the mechanism behind the self-deploy-502-but-succeeds quirk.
