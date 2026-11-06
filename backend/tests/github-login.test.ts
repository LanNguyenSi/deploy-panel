import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GitHub logins are case-insensitive, so the allowlist check compares
 * normalised (trimmed, lowercased) values. An empty allowlist means "no
 * allowlist enforced" (accept any verified login). The default allowlist is
 * read from the config module, so the tests inject it through a config mock
 * with the same shape the route tests use (allowedGitHubLogins by reference).
 */

const { allowedLoginsMock } = vi.hoisted(() => ({
  allowedLoginsMock: [] as string[],
}));

vi.mock("../src/config/index.js", () => ({
  allowedGitHubLogins: allowedLoginsMock,
}));

import {
  isAllowedGitHubLogin,
  normalizeGitHubLogin,
} from "../src/lib/github-login.js";

describe("normalizeGitHubLogin", () => {
  it("trims and lowercases", () => {
    expect(normalizeGitHubLogin(" Alice ")).toBe("alice");
    expect(normalizeGitHubLogin("MIXED-Case")).toBe("mixed-case");
  });

  it("maps empty and whitespace-only input to the empty string", () => {
    expect(normalizeGitHubLogin("")).toBe("");
    expect(normalizeGitHubLogin("   ")).toBe("");
  });
});

describe("isAllowedGitHubLogin", () => {
  beforeEach(() => {
    allowedLoginsMock.length = 0;
  });

  it("allows an exact-case entry against an exact-case login", () => {
    expect(isAllowedGitHubLogin("alice", ["alice"])).toBe(true);
  });

  it("allows an all-upper entry against a mixed-case login", () => {
    expect(isAllowedGitHubLogin("Mixed-Case-User", ["MIXED-CASE-USER"])).toBe(true);
  });

  it("allows a mixed-case entry against a mixed-case login", () => {
    expect(isAllowedGitHubLogin("mIxEd-cAsE-uSeR", ["Mixed-Case-User"])).toBe(true);
  });

  it("allows when entry and login differ only in casing on either side", () => {
    expect(isAllowedGitHubLogin("Alice", ["alice"])).toBe(true);
    expect(isAllowedGitHubLogin("alice", ["Alice"])).toBe(true);
  });

  it("allows when both entry and login are whitespace-padded", () => {
    expect(isAllowedGitHubLogin("  Alice  ", ["  alice "])).toBe(true);
  });

  it("refuses a login that is not in the list, whatever the casing", () => {
    expect(isAllowedGitHubLogin("mallory", ["alice", "bob"])).toBe(false);
    expect(isAllowedGitHubLogin("Mallory", ["alice", "bob"])).toBe(false);
  });

  it("allows any login when the allowlist is empty", () => {
    expect(isAllowedGitHubLogin("anyone", [])).toBe(true);
    expect(isAllowedGitHubLogin("", [])).toBe(true);
  });

  it("never matches an empty login against a non-empty allowlist", () => {
    expect(isAllowedGitHubLogin("", ["alice"])).toBe(false);
    expect(isAllowedGitHubLogin("   ", ["alice"])).toBe(false);
  });

  it("never matches a login against whitespace-only or empty entries", () => {
    // The config parse drops such entries; the helper must not match ""
    // even when handed a list that still holds them.
    expect(isAllowedGitHubLogin("alice", ["", "  "])).toBe(false);
    expect(isAllowedGitHubLogin("", ["", "  "])).toBe(false);
    expect(isAllowedGitHubLogin("   ", ["alice", " "])).toBe(false);
  });

  it("falls back to the config allowlist and matches it case-insensitively", () => {
    allowedLoginsMock.push("Mixed-Entry");
    expect(isAllowedGitHubLogin("mixed-entry")).toBe(true);
    expect(isAllowedGitHubLogin("other")).toBe(false);
    allowedLoginsMock.length = 0;
    expect(isAllowedGitHubLogin("anyone")).toBe(true);
  });
});
