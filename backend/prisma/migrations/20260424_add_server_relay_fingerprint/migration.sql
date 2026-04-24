-- Persist the SSH host-key fingerprint captured during the onboarding
-- probe so re-install can pin against it (catches MITM / VPS-rebuild
-- between initial install and re-install). Also persist the resolved
-- RELAY_MODE so the re-install UI can default to the same mode without
-- asking the operator to remember.
--
-- Both columns are nullable:
--   - Legacy rows (pre-v0.2.0 wizard) have no recorded fingerprint.
--   - relayMode may be absent when the installer was v0.1.x (no `Mode:`
--     output line to parse).
-- The re-install route treats both as "unknown → require user to
-- re-TOFU / re-pick mode" rather than failing.

ALTER TABLE "servers" ADD COLUMN "hostKeySha256" TEXT;
ALTER TABLE "servers" ADD COLUMN "relayMode" TEXT;
