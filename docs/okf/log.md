# Log

<!-- Add new entries at the top, newest first. -->

- 2026-10-09T14:21:38Z, JSON-blocked step for task 90d2d6bc: the JSON fallback in `stream-deploy.ts` now appends a relay `result.preflight` report to the relay's own steps when `result.blocked` is true (the report is the only step when the relay sent none), so the structured per-check verdicts are kept in the deploy log. `deploy-outcome-trust-chain.md` states this and, with `realtime-update-strategy.md`, had its `stream-deploy.ts` line citations after the new block (+13 lines) re-pointed; their other claims were re-read against the changed code and are unaffected.

- 2026-10-07T04:40:58Z, rollback proof by relay capability for task 8eabedcc: `assessRollbackReached` now picks a recovered rollback's entry by deploy id on an id-capable relay (no since-start window or exactly-one rule) and keeps the window and exactly-one rule on a relay that is not id-capable. An explicit `to_commit` sha must equal `commitAfter`; an omitted or symbolic one is proven only on an id-capable relay, by the id-matched entry whose `commitAfter` differs from its `commitBefore` (agent-relay's `rollbackApp` outcome carries `commitBefore`, read at origin/main), because the UI button and the MCP client send no `to_commit`. `deploy-outcome-trust-chain.md` had its rollback paragraph rewritten per relay capability and per `to_commit` form, and every citation into `deploy-recovery.ts` (+3 lines) and `deploy-target.ts` (checkDeployTarget, +30 lines) re-pointed with anchors verified. Re-stamped; `okf-kit check --require-anchors docs/okf` was run after the last source commit.

- 2026-10-07T04:26:38Z, rollback proof for task 8eabedcc: a connection-lost rollback is now judged by `assessRollbackReached` against the requested `to_commit` (one rollback-shaped relay entry since the start, deploy id on an id-capable relay, success on HEAD == requested commit) instead of the id-only `idPathOnly` check, and ends `interrupted` on every relay without that proof. `deploy-outcome-trust-chain.md` was re-verified against `deploy-recovery.ts`, `deploy-target.ts` and both rollback routes, its rollback paragraph and a what-breaks-it bullet were rewritten, and every citation into the two moved files was re-pointed with anchors verified. Re-stamped; `okf-kit check --require-anchors docs/okf` was run after the last source commit.

- 2026-10-06T15:33:00Z, citation correction for task 2e82656c: the previous entry said the `api.ts` citations did not move, which was wrong. The `api.ts` addition (+13 lines, `getAppsUpstream` and its types) shifted them earlier, and they had not been re-pointed. `realtime-update-strategy.md` now cites `sseStream` at `frontend/src/lib/api.ts:208-271` and its doc comment at `api.ts:195-200`, and the deploy-polling block in the server page at `page.tsx:162-187` (the in-flight upstream state added lines before it). Claims unchanged. `app-secrets-config-footgun.md` (sources `docs/api.md`) re-checked against the reworded upstream row: no claim changed, re-stamped. The server page's upstream in-flight counter was committed after the first re-stamp and does not change the cited `page.tsx:162-187` range (same line count); both docs were re-stamped again after that commit. `okf-kit check` was run after the last source commit.

- 2026-10-06T14:20:56Z, upstream route for task 2e82656c: the app list stays database-only and staleness moved to `GET /api/servers/:serverId/apps/upstream`. `realtime-update-strategy.md` re-pointed its deploy-polling citation in the server page (`page.tsx` 156-177, shifted by the new upstream state and loader); the `api.ts` citations did not move. `deploy-outcome-trust-chain.md` re-verified against `routes/apps.ts` (list route unchanged in behaviour, new sibling route; its rollback claims are untouched) and `app-secrets-config-footgun.md` against `docs/api.md` (list and upstream rows only): no claim changed, re-stamp only. `okf-kit check` was run after the source commit.

- 2026-10-06T14:07:40Z, upstream badge for task 2e82656c: `realtime-update-strategy.md` line citations into `frontend/src/lib/api.ts` (+13 lines) and the server page (+1 import line) shifted and were re-pointed; its claims are unaffected. `deploy-outcome-trust-chain.md` re-verified against `relay.ts` (new optional `timeoutMs`, default unchanged at 5 minutes) and `routes/apps.ts` (list route only), and `app-secrets-config-footgun.md` against `docs/api.md` (list row text only): no claim changed, re-stamp only. `okf-kit check docs/okf` was run after the source commit.

- 2026-10-06T09:40:06Z, review fixes for task ec0cd6ea: `deploy-outcome-trust-chain.md` citations re-pointed after the JSDoc edits in `deploy-target.ts` and `deploy-recovery.ts`, the app-card update citation now spans the whole update, and the recovered-rollback fail-closed cases (app lookup throws, start time unreadable) are stated.

- 2026-10-06T09:28:50Z, relay-capability id path for task ec0cd6ea: `checkDeployTarget` reads the relay version from `GET /health` and treats a relay at or above `RELAY_DEPLOY_ID_MIN_VERSION` as id-capable (an id in the history still counts), so an id-capable relay with no entry for the deploy's id is not reached; recovered rollbacks run the id-matched check against an id-capable relay (`idPathOnly`) and keep the health-only verdict otherwise. `deploy-outcome-trust-chain.md` was updated for both and every citation into `deploy-target.ts` (checkDeployTarget, assessTargetReached, commitsMatch) and `deploy-recovery.ts` (shifted by 3 to 5 lines) was re-pointed with anchors verified. Re-stamped; `okf-kit check --require-anchors docs/okf` was run after the source commit.

- 2026-10-06T07:25:30Z, review round 2 notes for task 59da7c87: `deploy-outcome-trust-chain.md`'s connection-lost section now says the timing correlation applies while the app's recent relay history holds no id-bearing entry (not only against a relay that records no ids), the rollback opt-out rationale is limited to that timing path (an id-matched check for recovered rollbacks is a follow-up), and the `stream-deploy.ts` citation is narrowed to 159-166 with an anchor on its last content line. The matching JSDoc in `deploy-recovery.ts` was reworded with the same line count, so no cited range moved. Re-stamped; `okf-kit check --require-anchors docs/okf` was run after the source commit.

- 2026-10-06T07:20:06Z, review fixes for task 59da7c87: `deploy-outcome-trust-chain.md` now states that the id path is chosen from the relay history (an id-bearing entry), not from relay capability, so the non-panel-deploy residual still applies while the app's recent history holds none (first panel deploy after a relay upgrade; a capability gate is a follow-up); it also says a stuck panel rollback row whose own id-matched entry succeeded and matches HEAD is finalized `success` (previously always `interrupted`), and the `stream-deploy.ts:159-168` citation got an anchor. `relayRequest` drops caller `content-type`/`authorization` headers case-insensitively (sources `relay.ts`, claims unaffected). The `deploy-target.ts` docblock was reworded without changing its line count, so cited ranges did not move. Re-stamped; `okf-kit check --require-anchors docs/okf` was run after the source commit.

- 2026-10-06T07:00:35Z, deploy id for task 59da7c87: the panel now sends its Deploy row id as `X-Deploy-Id` on every relay deploy and rollback call, and `assessTargetReached` matches the relay history entry carrying that `deployId` when the relay records ids (an older relay without the field keeps the timing correlation). `deploy-outcome-trust-chain.md` describes the id match, the fallback and the 400 handling, and every citation into `stream-deploy.ts` (3 lines added in `streamDeploy`, later citations shifted by 3) and `deploy-target.ts` was re-pointed with anchors verified. `realtime-update-strategy.md` (sources `stream-deploy.ts`) had its two `stream-deploy.ts` citations shifted by 3, claims unaffected. Both docs re-stamped; `okf-kit check --require-anchors docs/okf` was run after the source commit.

- 2026-10-06T04:21:42Z, recovery follow-up for task 82713feb: the target check in
  `recoverBrokenDeploy` now runs for every kind except `"rollback"` (fail
  closed), its JSDoc gained the in-flight residual (3 lines, later citations
  shifted by 3), and the shared target-check JSDoc in `deploy-target.ts` names
  both callers (1 line, later citations shifted by 1). All
  `deploy-outcome-trust-chain.md` citations into both files were re-pointed and
  their anchors verified; the poll-window claim now cites the constants and the
  `lastDeployAt` claim cites the app update. `docs/api.md` and
  `docs/architecture.md` list `interrupted`; `app-secrets-config-footgun.md`
  (sources `docs/api.md`) re-checked, its claims are unaffected. Both docs
  re-stamped.

- 2026-10-06T04:12:19Z, deploy-outcome-trust-chain.md re-verified and re-stamped after connection-lost recovery gained the stuck sweep's target check (task 82713feb): a healthy probe alone no longer makes `recoverBrokenDeploy` write success for a deploy (it needs no later panel Deploy row and exactly one matching relay success entry whose commitAfter is HEAD, otherwise `interrupted` with the failed check named); the check moved to the new `backend/src/lib/deploy-target.ts` (added to `sources`) and is shared with the sweep; the rollback routes keep the health-only verdict. All `startup.ts` and `deploy-recovery.ts` citations were re-pointed with anchors. Container `CreatedAt` is deliberately not used as a condition (compose up -d on an unchanged image does not recreate containers). `okf-kit check --require-anchors docs/okf` was run after the source commit.
- 2026-10-05T14:23:20Z, task 9791c995 (review round 3 fixes): `assessTargetReached` now rejects a relay entry without `triggeredBy`, and the sweep names a failed later-deploy lookup as such; `deploy-outcome-trust-chain.md` says so in (b), names the single-HTTP-API-deploy residual in (a), and its two `startup.ts` sweep citations were re-pointed (288-327, 310-312). Re-stamped.
- 2026-10-05T14:13:45Z, deploy-outcome-trust-chain.md re-verified and re-stamped after the stuck-deploy sweep's target check was tightened (task 9791c995): besides a successful relay entry matching HEAD it now requires no later panel Deploy row for the app, exactly one relay history entry since the start, a relay-API trigger, a positive durationMs and an entry start within a 10 s clock tolerance of the stuck start; the target always comes from the relay entry (the record's commitAfter preference was removed as dead code). The claim that the relay records only after build, up and health was corrected (it records every non-blocked result, failures as failed), the clock-skew paragraph now states both directions, and the startup.ts citations were re-pointed. app-secrets-config-footgun.md and auth-and-ownership-model.md re-stamped after docs/configuration.md's `PANEL_SELF_APP_NAME` row gained the app-name-only and compose-forwarding note; their claims are unaffected. `okf-kit check --require-anchors docs/okf` was run after the source commit.
- 2026-10-05T14:00:44Z, deploy-outcome-trust-chain.md re-verified and re-stamped after the stuck-deploy sweep gained a target check (task 9791c995): for every app except the panel itself, `recoverStuckDeploys` now needs the relay's app detail to show a deploy recorded since the stuck record's start, a successful newest entry and a repo HEAD matching the target commit before it writes success, and the startup.ts line citations were re-pointed to the moved code. app-secrets-config-footgun.md and auth-and-ownership-model.md re-stamped after docs/configuration.md gained the optional `PANEL_SELF_APP_NAME` row; their claims (app secrets, credential shapes) are unaffected.
- 2026-10-05T06:19:14Z, deploy-outcome-trust-chain.md re-verified and re-stamped after the unhealthy-resolution bound for the panel's own HEALTHCHECK flags was corrected (task 3b28a0b1): Docker schedules the next probe one interval after the previous probe completes, so a fast-failing probe is reported unhealthy by ~31s and a hung probe by ~50s (15s + 4 x (5s + 3s) + 3s), not ~38s; the margin only matters for the healthy case since strict recovery records both unhealthy and still-starting as failed. The comment in deploy-recovery.ts was reworded with the same line count, so no cited line range moved. `okf-kit check --require-anchors docs/okf` was run after the source commit.
- 2026-10-05T06:01:12Z, deploy-outcome-trust-chain.md re-verified and re-stamped after the panel's own Dockerfile HEALTHCHECK flags changed (task 3b28a0b1): the margin paragraph now names `--interval=5s --timeout=3s --start-period=15s --retries=4` instead of the old 30s interval, and the matching comment in deploy-recovery.ts was updated without moving any cited line range. `okf-kit check --require-anchors docs/okf` was run after the source commit.
- 2026-10-04T14:09:07Z, app-secrets-config-footgun.md re-stamped after the env PUT row in docs/api.md was narrowed (audit-log entry only when something changed). The secrets routes this doc points to are unchanged.
- 2026-10-04T14:04:17Z, app-secrets-config-footgun.md re-stamped after docs/api.md gained the install-relay row and reworded the env update and deploy lookup rows; its claims about secrets are unaffected. `okf-kit check --require-anchors docs/okf` was run after the source commit.
- 2026-10-04T13:57:32Z, app-secrets-config-footgun.md re-stamped after docs/api.md gained rows for the app tag, live-url, hide, deploy lookup, bulk-deploy and env routes; its claims about secrets are unaffected. `okf-kit check docs/okf` was run after the source commit.
- 2026-10-03T12:12:29Z, okf-staleness workflow re-synced from the okf-kit
  workflow template (fleet convergence ticket fdc01728): the workflow header
  now names the template as its source instead of calling the file a pattern
  to keep in sync, the pin moved from okf-kit@0.10.0 to okf-kit@0.16.0,
  `--require-anchors` joined the invocation, and the job stays warn-only.
  Measured on the tree before the change with `okf-kit check --json <bundle>`:
  at okf-kit@0.10.0, 0 errors, 0 warnings, 0 notices (exit 0) plain and 0
  errors, 71 warnings, 0 notices (exit 0) with `--require-anchors`; at
  okf-kit@0.16.0, 0 errors, 0 warnings, 0 notices (exit 0) plain and 0 errors,
  71 warnings, 0 notices (exit 0) with `--require-anchors`. Of the
  anchored-run warnings, 71 are anchor-required findings (full citations
  without an anchor); anchoring them is separate work and none of them blocks
  anything.
- 2026-10-03T12:32:53Z, task 994f6c81 comment-only follow-up: the `after_reset` comments in lib/rollback-app-status.ts and both rollback routes now say the relay attempted the reset (tree moved or partly rewritten). deploy-outcome-trust-chain.md already states that meaning and has no line citations into these files; re-stamped only.

- 2026-10-03T12:18:46Z, task 994f6c81 review fix: `RelayError` now carries the raw relay response text as `body` and `rollbackFailurePhase` parses it first, falling back to the message. deploy-outcome-trust-chain.md re-verified against the changed `lib/relay.ts`, `lib/rollback-app-status.ts` and both rollback routes (no line citations to them; `relay.ts` added to its sources; `after_reset` reworded to a reset attempted, `before_reset` to HEAD not moved). Re-stamped it and app-secrets-config-footgun.md (sourced on docs/api.md; only the rollback row changed, so re-stamp only). `okf-kit check docs/okf` was run after the source commit.

- 2026-10-03T12:08:10Z, task 994f6c81 rollback error phase: deploy-outcome-trust-chain.md rollback section now describes the relay's additive `phase` (`before_reset`/`after_reset`) on a rollback 4xx, the new `rollbackFailurePhase` and `setAppStatusAfterRollbackRejection` helpers in lib/rollback-app-status.ts, and the missing-phase-is-before_reset rule; the old claim that a 4xx leaves the app status untouched is narrowed to before_reset. docs/api.md rollback row updated the same way. Re-stamped app-secrets-config-footgun.md (sourced on docs/api.md): its claims are unaffected by the rollback row edit, so it was only re-stamped.

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
