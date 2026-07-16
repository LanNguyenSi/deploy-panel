---
type: overview
title: App secrets config footgun — why secret-crypto.ts reads process.env directly
description: Pointer doc — docs/configuration.md#app-secrets and docs/api.md are the authoritative, current references for the app-secrets feature; this entry only adds why lib/secret-crypto.ts deliberately reads process.env directly instead of importing config/index.ts, which neither doc states.
tags: [secrets, config, pointer]
timestamp: 2026-07-16T05:46:15Z
sources:
  - docs/configuration.md
  - docs/api.md
  - backend/src/lib/secret-crypto.ts
  - backend/src/config/index.ts
---

# App secrets config footgun — pointer

The authoritative references are [../configuration.md](../configuration.md)
("App secrets" section) for the feature's behavior (write-only storage,
required-env hard-fail gate, the rollback exemption) and
[../api.md](../api.md) for the routes. Both are current against main and
deliberately not restated here.

What neither doc states, because it's an implementation detail rather than
product behavior: `backend/src/lib/secret-crypto.ts` deliberately reads
`process.env.APP_SECRETS_KEY` and `process.env.NODE_ENV` directly
(`keyMaterial`, secret-crypto.ts:34-53) instead of importing
`config/index.ts`. `config/index.ts`'s top-level `configSchema.safeParse`
calls `process.exit(1)` when ANY required var — not just
`APP_SECRETS_KEY`, e.g. `SESSION_SECRET` too — is missing or invalid
(config/index.ts:35-39). That side effect is correct for the server
entrypoint, but wrong for a leaf crypto module that other modules
(`apps.ts`, `v1.ts`, `stream-deploy.ts` and its transitive importers) pull
in. A test suite that mocks Prisma/relay but never sets `SESSION_SECRET`
must be able to import `secret-crypto.ts` without the whole process
exiting under it. The module's own doc comment (secret-crypto.ts:17-25)
cross-references the same "no silent errors" convention this footgun note
does: reading `process.env` directly here is a deliberate, documented
exception, not an oversight to "fix" by switching it to `config.APP_SECRETS_KEY`.
