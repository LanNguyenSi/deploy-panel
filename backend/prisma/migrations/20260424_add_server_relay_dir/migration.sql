-- Persist the directory on the VPS where agent-relay's
-- docker-compose.yml lives. install.sh accepts a custom RELAY_DIR
-- (default /opt/agent-relay), and the re-install + update-image
-- flows now template this value into their SSH commands instead of
-- hardcoding /opt/agent-relay. Null for legacy rows → defaults to
-- /opt/agent-relay.

ALTER TABLE "servers" ADD COLUMN "relayDir" TEXT;
