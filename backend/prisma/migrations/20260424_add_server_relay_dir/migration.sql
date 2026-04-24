-- Persist the directory on the VPS where agent-relay's
-- docker-compose.yml lives. install.sh accepts a custom RELAY_DIR
-- (default /opt/agent-relay), and the re-install + update-image
-- flows now template this value into their SSH commands instead of
-- hardcoding /opt/agent-relay. Null for legacy rows → defaults to
-- /opt/agent-relay.

ALTER TABLE "servers" ADD COLUMN "relayDir" TEXT;
-- Compose-file basename. Null = `docker-compose.yml` (installer
-- default). Non-default values like `docker-compose.prod.yml` are
-- needed when the operator installed manually with a prod override
-- (container_name: agent-relay, Traefik labels, /root/git → /apps bind
-- mount) and update-image / re-install must use `-f <file>` to avoid
-- recreating the container via the dev compose file.
ALTER TABLE "servers" ADD COLUMN "relayComposeFile" TEXT;
