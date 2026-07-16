# Log

<!-- Add new entries at the top, newest first. -->

- 2026-07-16T05:46:15Z, initial 6 docs authored and verified against sources
  at the current working tree (branch `docs/okf-bundle`, off master commit
  `9cd0c5d`): auth-and-ownership-model, deploy-outcome-trust-chain,
  vps-onboarding-relay-provisioning, realtime-update-strategy,
  schema-migrations-mechanism (pointer), app-secrets-config-footgun
  (pointer). Also amended `docs/architecture.md`'s relay-integration
  paragraph, which claimed an unreachable/erroring relay always marks a
  deploy failed — incomplete: connection-loss recovery can confirm success
  via the post-deploy health gate (see deploy-outcome-trust-chain.md).
