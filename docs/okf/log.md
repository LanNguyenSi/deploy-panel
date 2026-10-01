# Log

<!-- Add new entries at the top, newest first. -->

- 2026-10-01T06:51:18Z, deploy-outcome-trust-chain.md: corrected the rollback section: a relay-reported rollback success now goes through verifyDeployHealth (shared helper lib/rollback-app-status.ts, added to sources) and only a passing verdict writes healthy plus lastDeployAt, a failing one writes unhealthy; blocked and success:false write unhealthy; 4xx leaves the status untouched; the 5xx path stays with recoverBrokenDeploy and a never-ran rollback can still end as success; the poll contract lists rolled_back, failed and success. Sources re-verified against routes/apps.ts, routes/v1.ts and the new helper. docs/api.md is a source of app-secrets-config-footgun.md: its claims are unaffected by the POST /api/v1/rollback row edit, so that doc was only re-stamped.

- 2026-09-26T05:10:56Z, docs/configuration.md Local development wording: the `Invalid config` error for `SESSION_SECRET` is paraphrased instead of misquoted, and the schema-change step names the root `--schema` Prisma commands (or the make targets after exporting `.env`). Re-verified `app-secrets-config-footgun.md` and `auth-and-ownership-model.md`; neither cites the edited sentences, both still hold. Re-stamped both.

- 2026-09-26T05:02:48Z, local development docs: corrected docs/configuration.md's
  intro claim that the backend and frontend "pick up .env at the repo root"
  in local dev (verified false: neither loads .env on its own when run on
  the host; confirmed by running `cd backend && npx prisma db push`, which
  fails P1012 DATABASE_URL not found, versus running the same command from
  the repo root with `--schema backend/prisma/schema.prisma`, which loads
  the root .env and gets past config validation). Documented exporting
  .env (`set -a; . ./.env; set +a`) before `make dev` in both README.md and
  docs/configuration.md's "Local development" sections, relabeled README's
  Development-block `make setup` entry (was captioned as one-time setup,
  contradicting the documented failure), fixed the Key features claim of
  an audit trail per server (AuditLog has no serverId field), and restored
  the dangling `make clean` sentence in docs/configuration.md.
  docs/configuration.md is a source of app-secrets-config-footgun.md and
  auth-and-ownership-model.md; re-read both against the edited intro and
  "Local development" text: neither doc's claims reference that text
  (they cite "App secrets"/"Authentication" and secret-crypto.ts/auth
  middleware, both unchanged), both remain accurate, re-stamped only.

- 2026-09-26T04:50:40Z, README refresh moved README.md's "Docker deployment"
  section content into docs/configuration.md (already the fuller,
  authoritative version; no unique content merged) and corrected the
  "Local development" section's `make setup` + `make dev` sequence, which
  fails on a fresh clone (`APP_SECRETS_KEY` unset in `.env.example` makes
  the Docker backend container fail its startup validation) or otherwise
  conflicts with `make dev` on host port 3000 (the Docker frontend
  container). docs/configuration.md is a source of app-secrets-config-footgun.md
  and auth-and-ownership-model.md; re-read both docs against the new
  "Local development" text and the unchanged "App secrets"/"Authentication"
  sections they actually cite: neither doc's claims reference the edited
  text, both remain accurate, re-stamped only.

- 2026-09-02T04:49:13Z, okf-staleness CI pin bumped from okf-kit@0.3.1 to
  okf-kit@0.9.0 (fleet parity, measured: 0.8.0 and 0.9.0
  report identical findings on this bundle). Cleared the STALE findings the
  bump surfaced (`okf-kit check --json docs/okf`: errors 0, warnings 4,
  notices 3 before this entry's fixes; errors 0, warnings 0, notices 0
  after). app-secrets-config-footgun.md: `sources:` docs/configuration.md
  and docs/api.md both changed after the doc's timestamp; re-read both
  docs' "App secrets" sections and secret-crypto.ts:34-53 /
  config/index.ts:35-39 (the cited spans) against the doc's claims
  (write-only storage, required-env hard-fail gate, rollback exemption,
  process.env read instead of config/index.ts import): all still
  accurate, re-stamped only. auth-and-ownership-model.md:
  docs/configuration.md changed after the doc's timestamp; re-read its
  "App secrets"/auth sections, unaffected by this doc's claims, and the
  doc's own auth.ts citations against backend/src/middleware/auth.ts at
  HEAD (33-104, 51-68, 71-76, 79-88, 90-101, 34-43, 40-42, 36-39) plus
  backend/src/lib/ownership.ts (29-36, 42-53, 60-98): all still accurate,
  re-stamped. Three bare "auth.ts" citations, at lines 110 through 116,
  40 through 42, and 36 through 39, were ambiguous between
  backend/src/middleware/auth.ts and backend/src/routes/auth.ts (both in
  `sources:`); re-pointed to the full path backend/src/middleware/auth.ts
  (the correct target, content verified) to resolve the ambiguity, giving
  `backend/src/middleware/auth.ts:110-116`,
  `backend/src/middleware/auth.ts:40-42`, and
  `backend/src/middleware/auth.ts:36-39`. realtime-update-strategy.md:
  backend/src/lib/stream-deploy.ts changed after the doc's timestamp
  (activeDeployIds refcounted-registry refactor, #132, and the stuck-sweep
  fix, #131, both unrelated to the cited SSE-parsing/DB-write logic);
  re-read the cited spans stream-deploy.ts:235-268 (reader/split-on-`\n`
  event parsing) and :342-346 (Deploy.log write) at HEAD, line numbers and
  content both still exact matches, re-stamped only, no citation changes
  needed.

- 2026-08-22T07:30:28Z, deploy-outcome-trust-chain AND
  realtime-update-strategy line references refreshed for drift
  introduced by the relay-4xx fix (task 9c96a84a, branch
  task/9c96a84a-v1-deploys-server-resolution), which added a
  `failureStepLog` helper and a 4xx rejection branch to
  stream-deploy.ts, a net +37 lines. deploy-outcome-trust-chain.md:
  `finalizeDeploy` was cited as stream-deploy.ts:32-84, now 42-94;
  `streamDeploy` was cited as 90-241, now 100-274; the SSE `done`
  branch (`handleEvent`) was cited as :264-276, now 297-309; the
  JSON-fallback branch was cited as :154-194, now 187-227; the
  stream-ended-without-`done` branch was cited as :222-235, now
  255-268; the health-downgrade if/else was cited as :43-64, now
  53-74; the "failure written straight through" doc comment was cited
  as :22-30, now 32-40; `streamDeploy`'s catch block was cited as
  :236-240, now 269-273. The doc's "three shapes funnel through
  finalizeDeploy" claim no longer covers every relay outcome: the new
  4xx-rejection branch (stream-deploy.ts:172-181) writes `status:
  "failed"` directly and bypasses `finalizeDeploy`, because it can
  never be a success claim needing verification; the doc's choke-point
  language and "what breaks it" list were reworded to scope the
  invariant to outcomes that could report success, and the 4xx branch
  is now called out as a deliberate exception. realtime-update-strategy.md:
  the `streamDeploy` read-loop was cited as :196-220, now 229-253; the
  `handleEvent` "step" branch writing `Deploy.log` was cited as
  :257-263, now 290-296; the described mechanisms verified unchanged.
  auth-and-ownership-model.md cites ownership.ts/auth.ts, neither
  touched by this change, so left as-is. All rewritten citations
  re-verified by reading stream-deploy.ts at HEAD.

- 2026-08-22T04:53:32Z, deploy-outcome-trust-chain AND
  realtime-update-strategy line references refreshed for drift
  introduced by commit b8dd181, which touched stream-deploy.ts with a
  net +5 lines (6 added, 1 replaced) at line 48, shifting every symbol
  below it (fix-round on the 2026-08-21 docs-freshness audit, task
  e34b48e3). deploy-outcome-trust-chain.md: `finalizeDeploy` was cited
  as stream-deploy.ts:32-79, now 32-84; the JSON-fallback branch was
  cited as :149-189, now 154-194; the stream-ended-without-`done`
  branch was cited as :217-230, now 222-235; the health-downgrade
  if/else was cited as :43-59, now 43-64; `streamDeploy`'s catch block
  was cited as :231-235, now 236-240. `streamDeploy` (90-241) and
  `handleEvent`'s "done" branch (264-276), refreshed in the prior
  round, were re-checked and are still accurate.
  realtime-update-strategy.md: the `streamDeploy` read-loop was cited
  as :191-215, now 196-220; the `handleEvent` "step" branch writing
  `Deploy.log` was cited as :252-258, now 257-263. The described
  mechanisms verified unchanged; auth.ts ranges in
  auth-and-ownership-model.md were checked in the same audit and found
  NOT drifted, so left as-is.

- 2026-08-17T14:45:00Z, deploy-outcome-trust-chain re-verified and updated
  for the pending-health gate change (task 29dba1ee, branch
  task/incident-fu-panel-starting-window): optimistic path no longer treats
  `health: "starting"` as clean (bounded `pendingExtraAttempts` extension,
  unreadable-poll carry, pass-with-note on exhaustion); strict confirmation
  now also requires "none starting" (healthy-but-slow apps can fail the
  recovery window — documented); stale `post-deploy-gate.ts` line-range
  citations replaced with symbol references.

- 2026-07-16T05:46:15Z, initial 6 docs authored and verified against sources
  at the current working tree (branch `docs/okf-bundle`, off main commit
  `9cd0c5d`): auth-and-ownership-model, deploy-outcome-trust-chain,
  vps-onboarding-relay-provisioning, realtime-update-strategy,
  schema-migrations-mechanism (pointer), app-secrets-config-footgun
  (pointer). Also amended `docs/architecture.md`'s relay-integration
  paragraph, which claimed an unreachable/erroring relay always marks a
  deploy failed — incomplete: connection-loss recovery can confirm success
  via the post-deploy health gate (see deploy-outcome-trust-chain.md).
