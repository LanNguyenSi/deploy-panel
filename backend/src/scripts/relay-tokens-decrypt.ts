/**
 * Decrypt-back command for the relay-token encryption at rest
 * (backend/src/lib/relay-token.ts):
 *
 *   npm run relay-tokens:decrypt --workspace=backend -- --yes
 *
 *   docker compose -f docker-compose.prod.yml exec backend \
 *     node backend/dist/scripts/relay-tokens-decrypt.js --yes
 *
 * The npm script runs the compiled build (node dist/...), so `npm run build`
 * must have run first; the production image has neither the sources nor the
 * dev toolchain, so there the compiled form above is the only one (guard:
 * backend/tests/relay-tokens-decrypt-command.test.ts). Run the pass
 * immediately before switching back to the pre-encryption image: any restart
 * of the new image re-encrypts what this pass restored.
 *
 * Writes every decryptable `Server.relayToken` ciphertext back to plaintext,
 * for a ROLLBACK to a panel image that predates encryption at rest: an old
 * image sends the stored value to the relay as the bearer directly, so a
 * ciphertext row would authenticate with garbage. Rows that are already
 * plaintext, and ciphertext rows that do not decrypt (they need the same key
 * as everything else here, so a failure here is a wrong-key situation the
 * operator has to resolve anyway), are left untouched.
 *
 * Refuses to do anything without `--yes`. Take a database backup first
 * (`scripts/backup.sh` in docs/configuration.md, "Backup and restore"): this
 * rewrites secrets in place and a rollback forward afterwards re-encrypts
 * what is still plaintext on the next start.
 */

const args = new Set(process.argv.slice(2));

if (!args.has("--yes")) {
  console.error(
    "relay-tokens:decrypt rewrites every stored relay token to plaintext (for a rollback to a pre-encryption image). " +
      "Take a database backup first, then re-run with --yes.",
  );
  process.exit(2);
}

// Imported after the --yes gate so the refusal path pulls in neither Prisma
// nor the startup module.
const { unsealAllRelayTokens } = await import("../lib/startup.js");

try {
  await unsealAllRelayTokens();
} catch (err) {
  console.error("relay-tokens:decrypt failed:", err);
  process.exit(1);
}
