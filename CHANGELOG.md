# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **next 15.5.27** (GHSA-mcj8-r9mp-w47p, GHSA-4jqv-mc3x-m676): the lockfile resolves 15.5.27 with its matching `@next/env` and `@next/swc-*` packages and the `next` dependency floor is now `^15.5.27`.
- **`@modelcontextprotocol/sdk` 1.32.1** (GHSA-6qxp-vccf-f47h, task aff72e2b): the lockfile resolves 1.32.1 and the `mcp/` dependency range is now `^1.32.1`, so consumers cannot resolve an affected version. Since 1.30.1 the SDK's HTTP server transports apply a 4 MiB default request-body limit and a 100-message batch cap.

### Added

- MCP `deploy_app` returns a compact result by default (task bb8386cc): id, status, commits, duration, and per step name/status/duration, plus the last 20 lines (max 1500 characters) of a failing step's output, so a long build log no longer overflows the client's tool-result limit. Pass `verbose: true` for the full deploy, or use `deploy_status`. A preflight-blocked deploy is reduced to its failing checks (name and message, each capped at 300 characters), step names and statuses are capped at 120 characters, and the failing-output, raw and check text across all steps shares a budget of about 8000 characters, after which the response sets `detailsTruncated: true`. The backend endpoints are unchanged; `deploy_rollback` and `deploy_status` keep returning the full result.
- The server page marks apps whose deployed commit differs from their remote branch head (task 2e82656c). Each app card shows a Checking, Current, Outdated or Unknown badge (text and icon, not colour alone) with the short deployed and remote SHAs and when the relay checked; the page subtitle counts outdated apps. The app list stays database-only: `GET /api/servers/:serverId/apps` makes no relay call, and the page renders it first. The new `GET /api/servers/:serverId/apps/upstream` (same ownership check) returns `{ upstream: { <appName>: { branch, deployedCommit, remoteHead, checkedAt, state, reason? } } }`, read from the relay's `GET /api/apps` in one call with an 8 second budget and validated (40-hex SHAs, state enum, ISO-8601 `checkedAt`, short reason, a verdict that contradicts its commits is treated as unknown). The page fetches it after every list load and shows a neutral "Checking" badge until it arrives; a failed request maps every app to unknown ("upstream check failed"). `unknown` is never `current` and carries a distinct reason: "relay unreachable", "relay listing unavailable" (the relay answered without an `apps` array), "relay does not list this app" (the app is absent from the listing), "app not configured on relay" (the relay lists it as `configured: false`), "relay does not report upstream" (a configured entry without the field, as an older relay sends) or a malformed value. While a refetch is in flight, an app the current result does not cover shows "Checking" instead of a reason. The "Compare on GitHub" link appears only when the app's `repoUrl` is set and on github.com; nothing in the panel sets `repoUrl` today, so the link does not show yet (follow-up). No GitHub token is involved: the relay does the `ls-remote`. `relayRequest` gained an optional `timeoutMs`. The MCP `deploy_list_apps` output is unchanged (the v1 listing spans servers and would need one relay call each).

### Fixed

- MCP `deploy_app` compact result follow-ups (task 90d2d6bc): the ~8000-character details budget is charged at the JSON-escaped length (escape-heavy output no longer inflates the response several-fold), failing preflight checks keep their `critical` flag when it is a boolean and list critical failures first (before the 20-check cap), and the backend's non-streaming JSON-blocked relay response (`result.blocked`) now keeps the relay's own steps and appends the structured preflight report (`result.preflight`) as an extra step, as the streaming `blocked` event does, so the per-check verdicts and their critical flags reach the compact and verbose results. The registered MCP runs from the checkout's `mcp/dist`, so the compact result reaches a machine only after a rebuild there.

- A connection-lost rollback is recorded `success` only when the relay shows the rollback ran (task 8eabedcc). `recoverBrokenDeploy` with `kind: "rollback"` used to keep the health-only verdict on a relay that is not id-capable (and an id match alone on an id-capable one), so a rollback that never ran while the old version stayed healthy still ended `success`. It now needs no later panel deploy row for the app and a relay history entry shaped like a relay rollback (`triggeredBy` `api`, no positive `durationMs`, so a deploy entry is not taken for it) that is a `success` whose `commitAfter` equals the repo HEAD. The entry is chosen by relay capability: on an id-capable relay (`/health` version at or above 0.6.0, or an id in the history) it is the entry carrying the row's own deploy id (no since-start window, no exactly-one rule); otherwise it must be the only entry recorded at or after the start. What it must show about the target depends on `to_commit`: an explicit commit sha (short or full) must equal `commitAfter` on either relay; an omitted or symbolic target (`HEAD~1`; what the UI button and the MCP client send) cannot be compared, so it is proven only on an id-capable relay, by the id-matched entry having moved the repo (`commitAfter` differs from `commitBefore`), and is never proof on a relay that is not id-capable. The two rollback routes now pass the requested `to_commit` to `recoverBrokenDeploy`. Without proof the row ends `interrupted` and the `recovery` step names the failed check (`check failed: target not reached: ...`); the app card stays `healthy` and `lastDeployAt` does not move. The `idPathOnly` option of `checkDeployTarget` is replaced by `rollback: { requestedCommit }`, judged by the new `assessRollbackReached`.

- The deploy-id match is chosen by relay capability, not by what the app's recent relay history happens to contain (task ec0cd6ea). `checkDeployTarget` reads the relay's version from the public `GET /health` on every check (nothing is cached, so a panel restart changes nothing) and treats a relay at or above `RELAY_DEPLOY_ID_MIN_VERSION` (0.6.0, the expected first agent-relay release that records `X-Deploy-Id`: the relay's change is unreleased at 0.5.0, so the number is an assumption to confirm at its release, not a fact) as id-capable; an id in the history still counts as capable too. Against an id-capable relay, no entry carrying the deploy's id means not reached, including the first deploy after a relay upgrade while the recent history holds no id-bearing entry, which closes the non-panel-deploy residual described below for such relays. A relay whose `/health` cannot be read or reports no version keeps the previous history inference. The recovered-rollback rule from this change was tightened before release by the rollback-proof entry (task 8eabedcc) in this section, which states the rule that ships. If the release that ships the id support is not numbered 0.6.0, adjust `RELAY_DEPLOY_ID_MIN_VERSION`. A recovered rollback fails closed: when the relay cannot be asked for the app, or the row's start time cannot be read, it ends `interrupted`, not `success`.

- The stuck-deploy sweep and connection-lost recovery tie a relay history entry to their own panel deploy by id (task 59da7c87). The panel now sends the Deploy row id as `X-Deploy-Id` on every relay deploy (streaming) and rollback call, and `checkDeployTarget` requires the relay entry whose `deployId` equals it when the relay reports deployIds (agent-relay records the id since its deploy-id change), instead of inferring the entry from trigger, duration and timing; this closes the residual where a single non-panel deploy over the relay's HTTP API could not be told apart from a deploy that left no entry, once the app's recent relay history holds an id-bearing entry. While it holds none (an older relay, or for example the first panel deploy of an app after a relay upgrade, or an app deployed mostly over MCP or HTTP), the previous timing correlation runs and that residual still applies there (a relay whose `/health` version shows it records ids no longer depends on the history, see the capability entry above). A stuck panel rollback row whose own id-matched relay entry succeeded and matches HEAD is now finalized `success` (previously always `interrupted`). A relay `400` for the id is a deploy-start rejection: the row ends `failed` directly and never goes through connection-lost recovery. `relayRequest` gained an optional `headers` option (content type and bearer token cannot be overridden by it, matched case-insensitively).

- A connection-lost deploy is no longer recorded `success` just because the app answers healthy (82713feb). `recoverBrokenDeploy` used to take a healthy probe as success, which is also true when the relay stopped before the git pull and the old containers kept running. A recovered deploy now needs the same proof the stuck-deploy sweep requires: no other panel deploy row for the app created after it, and exactly one relay history entry since its start that is a success, was triggered over the relay API, carries a positive duration and whose `commitAfter` matches the repo HEAD. Healthy without that proof ends `interrupted`, and the `recovery` step says which check failed (`check failed: target not reached: ...`); the app card stays `healthy` (the previous version is up) and `lastDeployAt` does not move. The check is a shared module (`lib/deploy-target.ts`, `checkDeployTarget`) used by both paths; the sweep's behaviour is unchanged. Unlike the sweep, the panel's own app gets no preflight-only exemption here, since this code only reaches the check while the panel's containers have not been replaced. The two rollback routes pass `"rollback"` to opt out: the relay records a rollback without a duration, which the check rejects by design, so, against a relay that is not id-capable, a recovered rollback keeps the health-only verdict (a rollback that never ran while the old version stays healthy still ends `success` there; against an id-capable relay it gets the id-matched check, see the capability entry above). Residual: a relay that is still finishing the deploy when the check runs has not recorded it yet, which ends `interrupted` (fail closed) although the deploy may complete afterwards. The container `CreatedAt` from `GET /api/apps/:name` is deliberately not used: `compose up -d` on an unchanged image does not recreate containers, so it cannot be a required condition for success, and as an optional one it would never change a verdict.

- The stuck-deploy sweep no longer marks a deploy as `success` just because the app's relay preflight passes (9791c995). A deploy cut off before the git pull (the old containers still run) used to be recovered as `success` although the repo stayed on the old commit and the containers were never recreated. For every app except the panel itself, a recovered deploy is now `success` only when (a) no other panel deploy row (deploy, rollback, scheduled deploy) for the app was created after it, and (b) the relay's `GET /api/apps/:name` shows exactly one history entry recorded at or after the stuck record's start, that entry is a success, was triggered over the relay API (`triggeredBy` must be `api`; an entry without it is rejected), carries a positive `durationMs` (a rollback records none) and began no earlier than the stuck start minus a 10s clock tolerance, and its `commitAfter` matches the repo's current HEAD. Otherwise the record is `interrupted` and the `startup-recovery` step says which check failed. This change alone left a residual: if the cut-off deploy left no relay entry, a single later non-panel deploy over the relay's HTTP API could not be told apart from it, because the relay recorded no deploy id. The deploy-id entries above (59da7c87, ec0cd6ea) close it for relays that record deploy ids; against an older relay the inference described here still applies. The target always comes from the relay entry, since a running row never carries a commit. The panel's own self-deploy keeps the preflight-only verdict; its relay app name is `deploy-panel`, overridable with the new optional `PANEL_SELF_APP_NAME` env var, which `docker-compose.yml` and `docker-compose.prod.yml` now forward to the backend.

## [0.6.2] - 2026-10-05

### Changed

- The panel's own backend and frontend images now declare `HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=4` instead of the 30s interval with no start period (3b28a0b1). A healthy container resolves within ~5s of a recreate, a broken one is reported unhealthy by ~31s (fast-failing probe) up to ~50s (hung probe: `start_period + retries x (interval + timeout) + timeout`), and a steady-state blip must last 20s before the container is reported unhealthy. A panel self-deploy therefore no longer has to take the optimistic gate's pending extension, and the strict recovery window (last poll ~48s) has margin for the healthy case. A new static test (`backend/tests/dockerfile-healthcheck.test.ts`) guards the flags; the margin comments in `deploy-recovery.ts` and the OKF trust-chain doc are updated.

- `docker-compose.yml` now uses the same backend healthcheck timing as `backend/Dockerfile` (interval 5s, timeout 3s, start period 15s, 4 retries) instead of overriding it with 30s/5s/3, so the dev frontend, which waits for the backend's `service_healthy`, no longer waits up to 30s (b0fbdbe7). The CI smoke job polls `/api/health` itself and is unaffected. A static test fails when the two drift apart. `docker-compose.prod.yml` is unchanged.

### Fixed

- Characters outside the latin subset render in the brand fonts again (7ad79c03). The self-hosted fonts now also vendor the subsets the old `next/font/google` CSS served: latin-ext for Sora, Inter and JetBrains Mono, plus cyrillic, cyrillic-ext, greek, greek-ext and vietnamese for Inter and cyrillic, cyrillic-ext, greek and vietnamese for JetBrains Mono (`@fontsource-variable` 5.3.0, OFL files unchanged). They are plain `@font-face` rules with the fontsource `unicode-range` in `frontend/src/app/fonts-extra.css`, `font-display: swap`, never preloaded, so a latin-only page fetches none of them. `font-family` declarations use new `--font-display-stack`, `--font-sans-stack` and `--font-mono-stack` variables that put the extra faces ahead of the next/font family (whose metric-matched fallback would otherwise claim those glyphs). Offline builds are unaffected and the `next/font/google` CI guard is unchanged.

- `make build` (and `npm run build --workspace=frontend`) no longer fails after exporting `.env` as the Quick start shows: the frontend build script now runs `next build` with `NODE_ENV=production`, so the `NODE_ENV=development` from `.env.example` no longer breaks prerendering (10d04aa2). README and CONTRIBUTING drop the "run without an exported NODE_ENV" workaround.

## [0.6.1] - 2026-10-04

### Changed

- The frontend now self-hosts its fonts: `next/font/google` (Sora 500/700, Inter 400/500/600, JetBrains Mono 400/500) is replaced by `next/font/local` with vendored latin variable woff2 files and their OFL licenses in `frontend/src/fonts/`. `next build` no longer contacts fonts.googleapis.com or fonts.gstatic.com, so a malformed or throttled Google response can no longer fail CI or a deploy. The `--font-display`, `--font-sans` and `--font-mono` variables and `display: swap` are unchanged. Only the latin subset is vendored. `subsets: ['latin']` used to control preloading only: the Google CSS also served latin-ext faces for all three families and Cyrillic, Greek and Vietnamese faces for Inter and JetBrains Mono, so those glyphs (for example in server or app names and log output) now render in the fallback font. The UI's own strings use none of them. CI gains a guard that fails when `next/font/google` is imported again.
- CI: `release.yml` now passes step values into `run:` scripts through `env:` and shell variables instead of interpolating `${{ }}` expressions into the script text. The composite deploy action (`action/action.yml`) likewise reads `inputs.force` from `env:` in its preflight step, so a `force` value can no longer inject shell code. No behavior change for normal tags, versions and `force` values.

### Fixed

- A rollback that fails after the relay's `git reset --hard` (the relay answers HTTP 400, e.g. "Rebuild failed") now sets the app's status to `unhealthy` in both the v1 and the apps rollback routes. agent-relay tags its rollback error body with an additive `phase` (`before_reset` or `after_reset`); a before-reset 4xx (bad ref, unknown app) still leaves the status untouched, and so does a missing or unknown phase, so this is safe against a relay that has not been updated yet. Needs the matching agent-relay change to take effect.
- A rollback that the relay reports as blocked by preflight or `success: false` (v1 `POST /rollback` and the apps rollback route) now sets the app's status to `unhealthy` instead of leaving the stale value. A relay-reported rollback success now runs the same post-deploy health gate as a deploy and sets `healthy` plus `lastDeployAt` only when it passes, `unhealthy` otherwise; the apps route runs the gate after it has responded. A relay 4xx rollback failure that is tagged before-reset, or untagged (an older relay), still leaves the app status untouched. The 202 poll contract of `POST /api/v1/rollback` (poll `GET /api/v1/deploy/:id` until `status` leaves `running`) is documented in `docs/api.md`; its status code is unchanged.

### Security

- Lockfile-only CVE remediation, no source changes: `next` 15.5.21 -> 15.5.25 (GHSA-2xp9-vwfh-vxw4 critical RCE, GHSA-p293-qw3h-jr36), `sharp` override 0.35.3 -> 0.35.4 (GHSA-rgj7-g3m4-5g8c), `hono` 4.13.0 -> 4.13.7 in `backend/` (manifest floor ^4.12.23 -> ^4.13.7) and the `overrides.hono` floor in `mcp/` (GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx), `vitest`/`@vitest/mocker`/`@vitest/coverage-v8` 4.1.9/4.1.10 -> 4.1.11 in the root tree and `mcp/` (GHSA-82fw-gwwq-j7x9).
- Manifest-only `postcss` floor bump `^8.5.18` -> `^8.5.23` in root `package.json` (`overrides.postcss` and `overrides.next.postcss`) and `frontend/package.json` (GHSA-fxqj-rqcc-2cmp); the root lockfile already resolved `postcss@8.5.23`, so no lockfile version moved.
- Lockfile-only advisory fixes, no source changes: `fast-uri` 3.1.5 -> 3.1.7 (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp) and then 3.1.8 with `brace-expansion` patched in the `mcp/` lockfile (#138, #146); `qs` 6.15.2 -> 6.16.0 (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g, #139); `ip-address` 10.4.0 -> 10.7.2 and `undici` 7.29.0 -> 7.30.0 in the root and `mcp/` lockfiles (#145).

## [0.6.0] - 2026-09-01

**Headline: honest deploy state through failure and restart (health-fail diagnosis, a periodic stuck sweep, a refcounted active-deploy registry), stored deploy output surfaced in the panel UI, and MCP name-or-ID parity restored for rollback and list_apps, plus a `deploy_list` tool.**

### Added

- **Stored deploy step output rendered in the panel UI** (PR #129): the failure reason a step stores (a relay 4xx rejection or an SSE error, per PR #128) is now shown on the `/deploys` and `/servers/[id]` pages instead of requiring an API call to read it; the output panel opens by default when a step's status is not "success".
- MCP `deploy_list` tool wrapping `GET /api/v1/deploys` (optional `app`, `server`, `status`, `limit`) so an agent can find a `deploy_id` for `deploy_status`.

### Fixed

- **MCP `deploy_rollback` and `list_apps` resolve a server name again, not just an ID** (PR #127): `deploy_rollback` is repointed at `POST /api/v1/rollback`'s name-or-id resolution (replacing the ID-only panel-UI route it called before) and now polls to completion instead of returning the bare "running" placeholder the async v1 endpoint returns; `GET /api/v1/apps`'s `server_id` filter is resolved through the same helper server-side, fixing a raw-id-only Prisma filter that silently returned zero apps when a server name was passed.
- **`GET /api/v1/deploys` resolves `server_id` by name or ID** (PR #128): it previously filtered straight into a raw Prisma equality check, so passing a server name silently matched zero deploys instead of the caller's own deploys; it now resolves through the same `findOwnedServerByIdOrName` helper as the other v1 routes and answers 404 when the identifier does not resolve or belongs to another owner.
- **Relay 4xx deploy rejections no longer greenwashed** (PR #128): a blocked or rejected relay deploy call now surfaces as a failure carrying the relay's own JSON-encoded reason instead of being reported as a pass.
- **Health-check failures persist their diagnosis and rollback outcome instead of leaving the deploy stuck on "running"** (PR #130): closes the 2026-08-18 incident shape where a health-check failure that triggers the relay's auto-rollback could leave the deploy record running forever if the SSE stream closed before a trailing `done` event arrived; the terminal status, rollback steps and health-check output are now preserved either way.
- **A periodic guarded stuck sweep closes the remaining orphaned-"running" gaps** (PR #131): the stuck-deploy sweep previously ran once at process start, so a panel restart mid-deploy (including the self-deploy case) could leave a record running forever once it aged past the threshold; the sweep now also runs on an interval, guarded by a new active-deploy registry so it never touches a deploy genuinely still streaming in this process, and a `recoverBrokenDeploy` failure is now awaited and logged instead of producing an unhandled rejection.

### Internal

- Docs-freshness fixes (PR #126): qualified the MCP `deploy_rollback` README claim (it calls the panel's non-v1 rollback route, which resolves the server by ID, not the name the tool's own input still advertises), corrected the README's Docker port claim (the db is additionally published on `127.0.0.1:5433` for host-run dev tooling, not just the frontend), and refreshed drifted line-range citations in `docs/okf/deploy-outcome-trust-chain.md`.
- Automated env-loading guard test (PR #127): pins that `APP_SECRETS_KEY`, which has no fallback default in `docker-compose.yml` and is fail-closed unlike `SESSION_SECRET`, actually reaches the backend child process through the `make dev-backend` -> `npm run` -> `tsx watch` chain.
- `deploy-recovery.ts`'s `activeDeployIds` Set replaced with a refcounted registry (`registerActiveDeploy`/`releaseActiveDeploy`/`isActiveDeploy`/`listActiveDeployIds`): the two rollback routes (`apps.ts`, `v1.ts`) and `recoverBrokenDeploy` each register/release their own hold on a deployId independently now, so both routes can use a plain unconditional `try`/`finally` instead of the `recovering` boolean that used to skip the delete when a hand-off occurred. Under the old flag, that skip meant the id stayed in the Set for the whole hand-off, so `recoverBrokenDeploy`'s own add was a no-op behind any number of awaits and ordering was not load-bearing. It is this refactor, replacing that conditional delete with an unconditional release, that makes ordering load-bearing for the first time: callers now release their own hold in the same synchronous turn as the hand-off, so `recoverBrokenDeploy`'s own `registerActiveDeploy` call must stay the first statement in its body, before any `await`, or the id briefly carries zero holds while recovery is still in flight.
- Stuck-sweep and deploy-delegation test coverage strengthened (PR #133): the stuck-sweep's live-sibling lookup test now inspects its own Prisma query arguments (scoped to app id and status "running") instead of a blind mock that stayed green even with `listActiveDeployIds()` replaced by `[]`; new tests assert that the deploy and bulk-deploy endpoints in `apps.ts` actually call `streamDeploy` with the right `deployId`/`appId`/`appName`/`relayUrl`, mirroring the existing delegation assertions for the v1 `/deploy` route and the scheduler's stuck sweep.

## [0.5.0] - 2026-08-20

**Headline: secrets provisioning in the deploy flow, honest rollback and health-gate reporting, and a broad security + test-coverage hardening round.** The app is deployed from `main`; this tag is deploy provenance.

### Added

- **App env/secrets provisioning through the deploy flow, with preflight hard-fail on missing keys** (PR #114).
- **Curated OKF knowledge bundle plus staleness drift-CI** (PR #115).

### Fixed

- **Blocked and failed relay rollbacks surface as errors instead of unconditional success** (PR #124); RelayError 4xx is no longer greenwashed by the recovery path.
- **Post-deploy gate treats unresolved "starting" health as not-yet-evidence** instead of a pass (PR #123).
- Not-found is distinguished from real errors in the apps, scheduled and api-keys routes (PRs #111, #112).

### Security

- Next.js SSRF patch (CVE-2026-64649) and remaining audit highs (PR #116); residual HIGH advisories closed (PR #117); `@hono/node-server` advisory closed in the mcp tree via SDK 1.30.0 (#118) and the backend moved to `@hono/node-server` 2.x (#119); lockfile-only audit fix from the 2026-08-04 CVE sweep (#120); nanoid floored to 3.3.18 (GHSA-2v37-7h3g-55p8, #122).

### Internal

- Test-coverage campaign across backend, frontend and mcp with coverage ratchets and new CI jobs (PRs #104 to #110, #113); frontend tests run on Node 22 and 26 (#121); README hero screenshot (#103).

## [0.4.0] - 2026-06-25

**Headline: the Mission Control design-system overhaul.** The frontend moves onto a new Mission Control design system, with a de-slopped sidebar, plus a hono CORS CVE patch. The app is deployed from `main`, so this tag is deploy provenance.

### Changed

- **Mission Control design-system overhaul** (PR #99): the frontend was lifted onto a new "Mission Control" design system.
- **De-slopped sidebar brand mark and active-link accent** (PR #100): the sidebar brand mark and the active-link accent were toned down to remove templated-looking flourishes.

### Security

- **Bump `hono` to 4.12.26** (PR #101): a lockfile-only bump (4.12.23 to 4.12.26) clearing a high-severity CORS advisory (wildcard origin with credentials) plus four moderate advisories, in the backend (root lockfile) and `mcp` dependency trees.

### Docs

- **README and docs reconciled with the code** (PR #98).

## [0.3.1] - 2026-06-16

**Headline: SSH credential hardening, two relay preflight fixes, and two esbuild CVE patches.**

### Security

- **SSH password passed as Buffer via `authHandler` so zeroing reaches ssh2** (PR #96).
  Previously the password was passed as a string; ssh2 copies strings internally and the
  copy was never wiped. Passing a Buffer lets ssh2's built-in zeroing reach the credential.
- **Force esbuild >=0.28.1 and bump tsx to ^4.22.4** (PRs #92, #93). Remediates
  GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr in the transitive esbuild dependency.

### Fixed

- **Compose-file fallback order probed in `update-relay-image` preflight** (PR #95).
  The preflight now probes Docker's compose-file search order so the correct file is
  selected before an image-only update is attempted, preventing silent no-ops when the
  relay compose file does not live at the default path.
- **Strict-mode host-key mismatch classified as `host_key_rejected`** (PR #94).
  A host-key mismatch raised under strict mode now surfaces as `host_key_rejected`
  instead of a generic connection error, giving callers an actionable signal.

## [0.3.0] - 2026-06-08

**Headline: a deploy reported `success` / app `healthy` now means the app
actually serves. A post-deploy health gate verifies container run-state and
the public route before a deploy is marked green, closing a gap where a
crashlooping sibling service or a Traefik 404 hid behind a zero exit code.
This release also folds in a HIGH-severity IDOR fix and a broad CVE sweep.**

### Added

- **Post-deploy health gate** (PR #88). After the relay reports a deploy
  success, the panel verifies the real post-deploy state before writing
  `success` / `healthy`: it polls container run-state via `docker compose ps`
  (flagging `restarting`, non-zero `exited`, `dead`, or `health=unhealthy`
  services) and probes the app's public `liveUrl` (404 / 408 / 5xx / transport
  error count as down; 401 / 403 / 429 are reachable). A crashlooping service
  or a 404 at the public host now downgrades the deploy to failed / unhealthy,
  with a step naming the offending container or HTTP code, and the app-list
  status reflects the verified state.
- **Non-admin relay install on owned servers** (PR #73). A broker-issued
  non-admin actor can install the relay on a server they own; previously
  admin-only.
- **`build:`-based compose detection in the update-relay-image preflight**
  (PR #72). Catches a `build:`-based relay compose before an image-only update
  silently no-ops.

### Security

- **SSRF-harden the post-deploy gate's server-side `liveUrl` probe** (PR #90).
  The probe resolves the host and refuses loopback / private / link-local /
  ULA / CGNAT targets (a DNS name pointing at an internal IP is blocked too),
  fails closed on unresolvable hosts, and no longer follows redirects.
  `PATCH /live-url` rejects internal literal hosts at write time. Reuses the
  existing `probe-guard` predicate so the two SSRF surfaces stay in sync.
- **Scope the deploy lookup to the owned `serverId`** (PR #83). Fixes a HIGH
  audit finding where a caller could read a deploy row on a server they do not
  own (cross-tenant IDOR).
- **CVE sweep** (PRs #74, #77, #78, #80, #81, #84, #85, #86, #87). Bump or
  override `next`, `hono` (app and `mcp/`), `vitest`, `qs`, `postcss`,
  `fast-uri`, `ip-address`, `express-rate-limit`, and remediate the MEDIUM
  audit findings.

### Fixed

- **Connection-lost recovery routed through the health gate** (PR #89). A
  deploy whose relay stream drops mid-restart is verified with the same gate
  in a fail-closed mode, instead of trusting the relay's `containers_running`
  preflight (which passed for any existing container), closing the same
  crashloop-as-healthy gap on the recovery path.
- The `error` deploy event now marks the app `unhealthy` instead of leaving it
  stuck on `deploying` (PR #88).

### Docs

- Document GitHub OAuth setup and the missing backend env vars (PR #82).
- Add the open-source surface: code of conduct, contributing guide, security
  policy, issue / PR templates (PR #76).
- README 60-second hook and restructure into `docs/` (PR #75).

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
