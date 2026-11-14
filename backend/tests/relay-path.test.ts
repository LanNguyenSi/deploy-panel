import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidAppNameError, relayAppPath } from "../src/lib/relay-path.js";

// Names accepted by the shared guard (app-name.ts) reach the relay path.
const VALID = ["app", "my-app.v2", "a_b", "9lives", "app.env", "a".repeat(300)];

// Names refused: traversal, path separators, whitespace, an already-encoded
// traversal, the empty string, and leading dot / hyphen / underscore.
const REFUSED = ["..", ".", "a/b", "a b", "%2e%2e", "", ".hidden", "-start", "_start", "a\\b", "app\nname"];

describe("relayAppPath accepts valid names", () => {
  it.each(VALID)("builds the bare path for %j", (name) => {
    expect(relayAppPath(name)).toBe(`/api/apps/${name}`);
  });

  const SUFFIXES: Array<[string, string]> = [
    ["/rollback", "/api/apps/app/rollback"],
    ["/logs", "/api/apps/app/logs"],
    ["/preflight", "/api/apps/app/preflight"],
    ["/env", "/api/apps/app/env"],
    ["/deploy", "/api/apps/app/deploy"],
  ];
  it.each(SUFFIXES)("appends the suffix %j", (suffix, expected) => {
    expect(relayAppPath("app", suffix)).toBe(expected);
  });

  it("passes the query string through verbatim", () => {
    expect(relayAppPath("app", "/logs", "?lines=25")).toBe("/api/apps/app/logs?lines=25");
    expect(relayAppPath("app", "/deploy", "?stream=true")).toBe("/api/apps/app/deploy?stream=true");
    expect(relayAppPath("app", "", "?x=1")).toBe("/api/apps/app?x=1");
  });

  it("encodes the name through encodeURIComponent (defense-in-depth)", () => {
    // The guard admits only characters encodeURIComponent leaves alone, so a
    // valid name encodes to itself. Stubbing the global with an observable
    // transform proves the helper routes the name through it: without the
    // encode call the stub never runs and the output loses the marker.
    const original = globalThis.encodeURIComponent;
    globalThis.encodeURIComponent = ((s: string) => `ENC(${s})`) as typeof encodeURIComponent;
    try {
      expect(relayAppPath("app", "/env")).toBe("/api/apps/ENC(app)/env");
    } finally {
      globalThis.encodeURIComponent = original;
    }
  });
});

describe("relayAppPath refuses invalid names", () => {
  it.each(REFUSED)("throws InvalidAppNameError for %j", (name) => {
    expect(() => relayAppPath(name)).toThrow(InvalidAppNameError);
    expect(() => relayAppPath(name, "/rollback")).toThrow(InvalidAppNameError);
  });

  it("names the refused value JSON-escaped, never raw, in the error message", () => {
    let err: unknown;
    try {
      relayAppPath('a"b');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidAppNameError);
    const message = (err as Error).message;
    expect(message).toContain(JSON.stringify('a"b'));
    expect((err as InvalidAppNameError).invalidName).toBe('a"b');
    expect((err as Error).name).toBe("InvalidAppNameError");
  });

  it("is an Error subclass named InvalidAppNameError", () => {
    const err = new InvalidAppNameError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InvalidAppNameError");
  });
});
