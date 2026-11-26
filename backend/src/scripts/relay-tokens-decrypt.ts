/**
 * Decrypt-back command for the relay-token encryption at rest
 * (backend/src/lib/relay-token.ts):
 *
 *   npm run relay-tokens:decrypt --workspace=backend -- --yes
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
