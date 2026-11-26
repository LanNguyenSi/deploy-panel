// The startup relay-token backfill and its decrypt-back (lib/startup.ts,
// backed by lib/relay-token.ts), against an in-memory prisma.server with real
// compare-and-set semantics:
//
// 1. Plaintext rows are sealed in place; the sealed value opens back to the
//    original token.
// 2. Rows already in ciphertext shape are decrypted-checked and untouched; a
//    second run changes nothing (idempotency).
// 3. A row changed concurrently (CAS miss on where { id, relayToken }) is
//    left for the next start, never clobbered.
// 4. A row in ciphertext shape that does not decrypt is left untouched and
//    named by id in the error log.
// 5. Production without APP_SECRETS_KEY: the pass rejects like every other
//    secret-crypto use (fail closed); with no rows it does not touch the key
//    at all.
// 6. unsealAllRelayTokens (the decrypt-back command's core) restores
//    plaintext by CAS and skips everything else.
//
// Token values never appear in any log line (checked with a marker).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { table, casApply } = vi.hoisted(() => {
  const table = new Map<string, string | null>();
  // Prisma updateMany semantics for this table: every key in `where` must
  // match (the CAS is `{ id, relayToken: <old> }` in lib/startup.ts), so a
  // row whose stored value moved matches nothing and yields count 0.
  const casApply = (where: any, data: any) => {
    const matches = Object.entries(where).every(([key, value]) =>
      key === "id" ? table.has(where.id) : table.get(where.id) === value,
    );
    if (matches) table.set(where.id, data.relayToken);
    return { count: matches ? 1 : 0 };
  };
  return { table, casApply };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findMany: vi.fn(async () =>
        [...table.entries()]
          .filter(([, token]) => token !== null)
          .map(([id, token]) => ({ id, relayToken: token })),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => casApply(where, data)),
    },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import {
  backfillRelayTokenCiphertext,
  unsealAllRelayTokens,
} from "../src/lib/startup.js";
import { openRelayToken, sealRelayToken } from "../src/lib/relay-token.js";
import { __resetSecretCryptoStateForTests } from "../src/lib/secret-crypto.js";

const mUpdateMany = prisma.server.updateMany as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL_APP_SECRETS_KEY = process.env.APP_SECRETS_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.APP_SECRETS_KEY = "a-fixed-32-char-test-key-value!";
  process.env.NODE_ENV = "test";
  __resetSecretCryptoStateForTests();
  table.clear();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_APP_SECRETS_KEY === undefined) delete process.env.APP_SECRETS_KEY;
  else process.env.APP_SECRETS_KEY = ORIGINAL_APP_SECRETS_KEY;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  __resetSecretCryptoStateForTests();
  vi.restoreAllMocks();
});

function allLogged(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
}

describe("backfillRelayTokenCiphertext", () => {
  it("seals a plaintext row so the stored value opens back to the token, and null rows are not read", async () => {
    table.set("s1", "PLAINTEXT-MARKER-token");
    table.set("s2", null);
    const summary = await backfillRelayTokenCiphertext();
    expect(summary).toMatchObject({ rewritten: 1, unchanged: 0, casMisses: 0, undecryptable: [] });
    const stored = table.get("s1")!;
    expect(stored).not.toBe("PLAINTEXT-MARKER-token");
    expect(openRelayToken(stored)).toBe("PLAINTEXT-MARKER-token");
    expect(table.get("s2")).toBeNull();
  });

  it("leaves ciphertext rows untouched and changes nothing on a second run (idempotent)", async () => {
    table.set("s1", "tok-1");
    await backfillRelayTokenCiphertext();
    const sealed1 = table.get("s1")!;
    mUpdateMany.mockClear();

    const second = await backfillRelayTokenCiphertext();
    expect(second).toMatchObject({ rewritten: 0, unchanged: 1, casMisses: 0, undecryptable: [] });
    expect(table.get("s1")).toBe(sealed1);
    expect(mUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves a concurrently changed row to the next start (CAS miss) and never clobbers it", async () => {
    // The CAS miss is modelled by a concurrent re-write DURING the awaited
    // update (the row moved away from the value the pass read): the
    // compare part of where { id, relayToken: <old> } is what the test
    // pins, so it must stay honest when the CAS is weakened in source.
    table.set("s1", "old-token");
    mUpdateMany.mockImplementationOnce(async ({ where, data }: any) => {
      table.set(where.id, "rotated-by-another-writer");
      return casApply(where, data);
    });
    const summary = await backfillRelayTokenCiphertext();
    expect(summary).toMatchObject({ rewritten: 0, unchanged: 0, casMisses: 1, undecryptable: [] });
    expect(table.get("s1")).toBe("rotated-by-another-writer");
    // The next start seals the rotated plaintext normally.
    const third = await backfillRelayTokenCiphertext();
    expect(third).toMatchObject({ rewritten: 1, casMisses: 0 });
    expect(openRelayToken(table.get("s1")!)).toBe("rotated-by-another-writer");
  });

  it("leaves a fake v1-shaped row untouched and names it by id in one error log", async () => {
    table.set("good", "plain-good-token");
    table.set("bad-id-42", "v1:AAA:BBB:CCC");
    const summary = await backfillRelayTokenCiphertext();
    expect(summary).toMatchObject({ rewritten: 1, unchanged: 0, casMisses: 0, undecryptable: ["bad-id-42"] });
    expect(table.get("bad-id-42")).toBe("v1:AAA:BBB:CCC");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const errLine = errSpy.mock.calls[0].map(String).join(" ");
    expect(errLine).toContain("bad-id-42");
    // Values are never logged: neither the bad row's fake token nor the
    // sealed row's plaintext.
    expect(allLogged()).not.toContain("plain-good-token");
    expect(allLogged()).not.toContain("AAA");
  });

  it("leaves an empty-string row unchanged: empty means no token, a sealed empty string would not be", async () => {
    // The write routes store null for an empty submission; a legacy "" row
    // must survive the pass untouched, never sealed into a truthy bearer.
    table.set("empty", "");
    table.set("real", "plain-token");
    const summary = await backfillRelayTokenCiphertext();
    expect(summary).toMatchObject({ rewritten: 1, unchanged: 1, casMisses: 0, undecryptable: [] });
    expect(table.get("empty")).toBe("");
    expect(openRelayToken(table.get("real")!)).toBe("plain-token");
  });

  it("production without APP_SECRETS_KEY: the pass rejects (secret-crypto fails closed) and writes nothing", async () => {
    table.set("s1", "plain-token");
    delete process.env.APP_SECRETS_KEY;
    process.env.NODE_ENV = "production";
    __resetSecretCryptoStateForTests();
    await expect(backfillRelayTokenCiphertext()).rejects.toThrow(/APP_SECRETS_KEY/);
    expect(table.get("s1")).toBe("plain-token");
  });

  it("production without APP_SECRETS_KEY and no stored tokens: the pass does not touch the key and succeeds", async () => {
    delete process.env.APP_SECRETS_KEY;
    process.env.NODE_ENV = "production";
    __resetSecretCryptoStateForTests();
    await expect(backfillRelayTokenCiphertext()).resolves.toMatchObject({
      rewritten: 0,
      unchanged: 0,
      casMisses: 0,
      undecryptable: [],
    });
  });
});

describe("unsealAllRelayTokens (decrypt-back)", () => {
  it("writes a sealed row back to plaintext by CAS, and leaves plaintext and undecryptable rows", async () => {
    table.set("sealed", sealRelayToken("ROLLBACK-MARKER-token"));
    table.set("plain", "already-plaintext");
    table.set("bad", "v1:AAA:BBB:CCC");
    const summary = await unsealAllRelayTokens();
    expect(table.get("sealed")).toBe("ROLLBACK-MARKER-token");
    expect(table.get("plain")).toBe("already-plaintext");
    expect(table.get("bad")).toBe("v1:AAA:BBB:CCC");
    expect(summary).toMatchObject({ rewritten: 1, unchanged: 1, casMisses: 0, undecryptable: ["bad"] });
    expect(errSpy.mock.calls[0].map(String).join(" ")).toContain("bad");
    expect(allLogged()).not.toContain("ROLLBACK-MARKER-token");
    // Idempotent: a second run finds only plaintext and the bad row.
    const second = await unsealAllRelayTokens();
    expect(second).toMatchObject({ rewritten: 0, unchanged: 2, undecryptable: ["bad"] });
  });

  it("leaves a concurrently changed row alone (CAS miss)", async () => {
    table.set("sealed", sealRelayToken("tok"));
    mUpdateMany.mockImplementationOnce(async ({ where, data }: any) => {
      table.set(where.id, "v1:something:new:newer");
      return casApply(where, data);
    });
    const summary = await unsealAllRelayTokens();
    expect(summary).toMatchObject({ rewritten: 0, casMisses: 1 });
    expect(table.get("sealed")).toBe("v1:something:new:newer");
  });
});

describe("the relay-tokens:decrypt command", () => {
  it("refuses without --yes (exit 2) and does not import the database path", () => {
    const backendDir = fileURLToPath(new URL("../", import.meta.url));
    const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    let status = 0;
    let output = "";
    try {
      output = execFileSync(tsx, ["src/scripts/relay-tokens-decrypt.ts"], {
        cwd: backendDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? -1;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(status).toBe(2);
    expect(output).toContain("--yes");
    expect(output).toContain("backup");
  });
});
