import { describe, expect, it } from "vitest";
import { InvalidAppNameError, RELAY_APP_NAME_PATTERN, relayAppPath } from "../src/lib/relay-path.js";

// Names the relay accepts (its APP_NAME rule, mirrored by RELAY_APP_NAME_PATTERN)
// reach the relay path. Leading `_` and `-` are part of this set: the relay
// accepts them, so the panel must accept them too (regression guard).
const VALID = ["app", "my-app", "_bad", "-bad", "a_b", "9lives", "deploy-panel", "_", "-", "a".repeat(300)];

// Names the relay refuses and the helper must refuse: traversal, path
// separators, whitespace, an already-encoded traversal, the empty string,
// leading dot, and dots anywhere (the relay's rule has no `.`, so dotted
// names were never operable at the relay).
const REFUSED = ["..", ".", "a/b", "a b", "%2e%2e", "", ".hidden", "a.b", "my.app.v2", "a\\b", "app\nname", "app.env"];

describe("relayAppPath accepts every name the relay accepts", () => {
  it.each(VALID)("builds the bare path for %j", (name) => {
    expect(relayAppPath(name)).toBe(`/api/apps/${name}`);
  });

  it("exports the relay's rule as a named pattern", () => {
    expect(RELAY_APP_NAME_PATTERN).toEqual(/^[a-zA-Z0-9_-]+$/);
    // Mirrors agent-relay's APP_NAME: leading underscore / hyphen in, dot out.
    expect(RELAY_APP_NAME_PATTERN.test("_bad")).toBe(true);
    expect(RELAY_APP_NAME_PATTERN.test("-bad")).toBe(true);
    expect(RELAY_APP_NAME_PATTERN.test("a.b")).toBe(false);
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

describe("relayAppPath refuses what the relay refuses", () => {
  it.each(REFUSED)("throws InvalidAppNameError for %j", (name) => {
    expect(() => relayAppPath(name)).toThrow(InvalidAppNameError);
    expect(() => relayAppPath(name, "/rollback")).toThrow(InvalidAppNameError);
  });

  // Relay JSON is untyped, so the typeof check runs before the regex: a
  // number would stringify into the charset (5 matches) and an object would
  // make .test throw "[object Object]" nonsense.
  it.each([5, 0, null, undefined, {}, [], true, ["a"] as unknown])("throws for the non-string input %j", (name) => {
    expect(() => relayAppPath(name as unknown as string)).toThrow(InvalidAppNameError);
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
