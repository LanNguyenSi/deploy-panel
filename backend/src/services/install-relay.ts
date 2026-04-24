/**
 * Relay-install orchestration. Wraps `executeSshCommand` with the
 * installer-specific concerns:
 *
 * 1. Build a shell-safe command string that injects validated env vars
 *    into `install.sh` without string-interpolating user input.
 * 2. Parse `URL:` and `Token:` out of the installer's final output.
 *
 * The module is pure — no SSH client state, no I/O of its own — so the
 * route layer can test it in isolation and the SSH-execution layer
 * (commit 1) stays focused on the transport.
 */

/**
 * URL the installer is pulled from. Hardcoded (not user-configurable
 * via request body) so a malicious caller cannot redirect the install
 * to a lookalike script.
 */
export const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh";

export interface InstallEnvVars {
  /** FQDN for Traefik TLS. Omit for port-only mode. */
  relayDomain?: string;
  /** Email for Let's Encrypt. Required if relayDomain is set. */
  traefikEmail?: string;
  /** Host dir on the VPS containing app repos. Defaults to install.sh's own default when omitted. */
  appsDir?: string;
}

/**
 * Shell-escape a value for embedding in a single-quoted string.
 * Wraps in `'…'` and replaces any internal single-quote with
 * `'"'"'` (close quote, literal quote, reopen). This is the standard
 * POSIX-portable shell-escape and protects against any metachar in
 * the value.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build the command that runs on the VPS. Structured as:
 *
 *   env VAR='…' VAR='…' bash -c 'curl … | sudo -E bash'
 *
 * User-supplied env values are single-quote-escaped so no value can
 * break out of its quoting. The inner bash -c runs a FIXED string —
 * the installer URL is compile-time and has no user-controlled parts.
 *
 * `sudo -E bash` preserves the env vars we set; install.sh reads
 * RELAY_DOMAIN, TRAEFIK_EMAIL, APPS_DIR from its process env.
 */
export function buildInstallCommand(env: InstallEnvVars): string {
  const envPairs: string[] = [];
  if (env.relayDomain !== undefined) {
    envPairs.push(`RELAY_DOMAIN=${shellEscape(env.relayDomain)}`);
  }
  if (env.traefikEmail !== undefined) {
    envPairs.push(`TRAEFIK_EMAIL=${shellEscape(env.traefikEmail)}`);
  }
  if (env.appsDir !== undefined) {
    envPairs.push(`APPS_DIR=${shellEscape(env.appsDir)}`);
  }
  const envPrefix = envPairs.length > 0 ? `env ${envPairs.join(" ")} ` : "";
  // INSTALL_SCRIPT_URL is a compile-time constant — not exposed to the
  // caller — so no interpolation risk here. The `|` pipe is shell
  // metasyntax by design; that's why we use bash -c explicitly.
  return `${envPrefix}bash -c 'curl -sSL ${INSTALL_SCRIPT_URL} | sudo -E bash'`;
}

/**
 * Strip ANSI color / cursor escape sequences so the token-parse regex
 * sees bare text. install.sh uses `${CYAN}…${NC}` around the URL and
 * `${YELLOW}…${NC}` around the token; those escapes would otherwise
 * sit between the label and the value.
 */
function stripAnsi(s: string): string {
  // Covers CSI sequences (`\x1b[…m`, `\x1b[…H`, etc.) and OSC close.
  // Small regex; not a full ANSI parser, but install.sh uses only the
  // simple color forms.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export interface InstallOutputParseResult {
  relayUrl: string;
  relayToken: string;
}

export interface InstallOutputParseError {
  kind: "token_not_found" | "url_not_found";
  message: string;
}

/**
 * Parse the final `URL: …` and `Token: …` lines from a successful
 * install.sh run. Matches the primary connection-info block (2-space
 * indent); the "Add to deploy-panel:" block later on uses "Relay URL:"
 * / "Relay Token:" labels and we deliberately don't match those —
 * they're the same values restated, and pinning to one source of
 * truth makes a future installer-format change easier to spot.
 *
 * Regex notes:
 * - `/m` to match per line
 * - `^\s*URL:\s+(\S+)` — tolerates the indent + any whitespace run
 * - We require `URL:` not `Relay URL:` to avoid matching the
 *   lower block. The negative-lookbehind would also work but adds
 *   regex complexity with no win.
 */
export function parseInstallOutput(
  stdout: string,
): { ok: true; value: InstallOutputParseResult } | { ok: false; error: InstallOutputParseError } {
  const clean = stripAnsi(stdout);
  const urlMatch = clean.match(/^[ \t]*URL:\s+(\S+)/m);
  if (!urlMatch) {
    return {
      ok: false,
      error: {
        kind: "url_not_found",
        message: "installer output did not contain a `URL:` line",
      },
    };
  }
  const tokenMatch = clean.match(/^[ \t]*Token:\s+(\S+)/m);
  if (!tokenMatch) {
    return {
      ok: false,
      error: {
        kind: "token_not_found",
        message: "installer output did not contain a `Token:` line",
      },
    };
  }
  return {
    ok: true,
    value: { relayUrl: urlMatch[1], relayToken: tokenMatch[1] },
  };
}
