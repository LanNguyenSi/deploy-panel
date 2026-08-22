# Log

<!-- Add new entries at the top, newest first. -->

- 2026-08-22T00:00:00Z, deploy-outcome-trust-chain line references
  refreshed for drift found in the 2026-08-21 docs-freshness audit
  (task e34b48e3): `streamDeploy` was cited as stream-deploy.ts:85-236,
  now 90-241; the `handleEvent` "done" branch was cited as :259-271,
  now 264-276. The described mechanisms verified unchanged; auth.ts
  ranges in auth-and-ownership-model.md were checked in the same audit
  and found NOT drifted, so left as-is.

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
