// A guarded SSH connect creates its own socket before ssh2's connect() runs.
// ssh2 throws synchronously for an unparsable private key; the lookup of the
// guarded host answers afterwards (immediately or late). The guard socket
// must be torn down on that path, otherwise its later lookup refusal is an
// unhandled 'error' event that ends the process.
import type dns from "node:dns";
import { createServer as createTcp, type AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { _setConnectResolver } from "../src/lib/connect-guard.js";
import { executeSshCommand } from "../src/services/ssh-executor.js";

afterEach(() => _setConnectResolver(null));

it("an unparsable private key on a guarded host fails as an SSH error without an uncaught socket error and without dialing", async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  let dials = 0;
  const tcp = createTcp((s) => { dials++; s.destroy(); });
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  const port = (tcp.address() as AddressInfo).port;
  const answers: Array<dns.LookupAddress[] | Error> = [
    Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }],
  ];
  const keys = ["not a key", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"];
  try {
    for (const delay of [0, 60]) {
      for (const answer of answers) {
        _setConnectResolver((_host, cb) => {
          const go = () => (answer instanceof Error ? cb(answer as NodeJS.ErrnoException, []) : cb(null, answer));
          if (delay) setTimeout(go, delay); else go();
        });
        for (const privateKey of keys) {
          const outcome = await executeSshCommand({
            host: "ssh.test", port, user: "root",
            auth: { kind: "privateKey", privateKey },
            command: "true", timeoutMs: 2000, guardTarget: true,
          }).then(() => "resolved", () => "rejected");
          expect(outcome).toBe("rejected");
          // give a late lookup answer time to land on the (destroyed) socket
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    await new Promise<void>((r) => tcp.close(() => r()));
  }
  expect(uncaught).toEqual([]);
  expect(dials).toBe(0);
});
