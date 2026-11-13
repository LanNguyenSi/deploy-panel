import { describe, expect, it, vi } from "vitest";

// The prisma stub only exists so the real relay.js loads without a generated
// client: envUnreadableRelayMessage itself never touches the database.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { server: { findUnique: vi.fn() } },
}));

import { RelayError, envUnreadableRelayMessage } from "../src/lib/relay.js";

describe("envUnreadableRelayMessage", () => {
  it("recognises a relay 409 and leads with the unreadable-env wording carrying the body's message field", () => {
    const body = JSON.stringify({ error: "env_unreadable", message: ".env is a symlink" });
    const msg = envUnreadableRelayMessage(new RelayError(`Relay error (409): ${body}`, 409, body));
    expect(msg).toBe("Env file unreadable on the relay: .env is a symlink");
  });

  it("message extraction precedence: body message field wins, then error field, then raw body text, then the error message", () => {
    const both = envUnreadableRelayMessage(
      new RelayError("m", 409, JSON.stringify({ message: "the message field", error: "the error field" })),
    );
    expect(both).toContain("the message field");
    expect(both).not.toContain("the error field");

    const onlyError = envUnreadableRelayMessage(new RelayError("m", 409, JSON.stringify({ error: "the error field" })));
    expect(onlyError).toContain("the error field");

    const nonJson = envUnreadableRelayMessage(new RelayError("m", 409, "plain text answer"));
    expect(nonJson).toContain("plain text answer");

    const noBody = envUnreadableRelayMessage(new RelayError("Relay error (409): text inside the message", 409));
    expect(noBody).toContain("Relay error (409): text inside the message");

    const neither = envUnreadableRelayMessage(new RelayError("Relay error (409):", 409, "  "));
    expect(neither).toBe("Env file unreadable on the relay: Relay error (409):");
  });

  it("bounds the extracted message at 300 characters", () => {
    const msg = envUnreadableRelayMessage(new RelayError("m", 409, "y".repeat(500)));
    expect(msg).toBe(`Env file unreadable on the relay: ${"y".repeat(300)}`);
  });

  it("returns null for anything that is not a relay 409", () => {
    expect(envUnreadableRelayMessage(null)).toBeNull();
    expect(envUnreadableRelayMessage(undefined)).toBeNull();
    expect(envUnreadableRelayMessage("Relay error (409): x")).toBeNull();
    expect(envUnreadableRelayMessage(new Error("boom"))).toBeNull();
    expect(envUnreadableRelayMessage(new RelayError("not found", 404, "nope"))).toBeNull();
    expect(envUnreadableRelayMessage(new RelayError("gateway", 502, "nope"))).toBeNull();
  });

  it("local wins: a panel-raised RelayError carrying a 409 is not the relay's unreadable-env answer", () => {
    expect(envUnreadableRelayMessage(RelayError.local("No relay URL configured", 409))).toBeNull();
    const err = new RelayError("Relay error (409): looks like one", 409, "looks like one");
    err.local = true;
    expect(envUnreadableRelayMessage(err)).toBeNull();
  });
});
