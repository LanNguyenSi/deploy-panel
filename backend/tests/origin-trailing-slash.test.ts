import { describe, expect, it } from "vitest";
import { trimTrailingSlashes } from "../src/lib/origin.js";

// Contract of the single trailing-slash trimmer for origin-shaped config
// values (backend/src/lib/origin.ts): only trailing slashes are removed,
// an origin with a path prefix keeps the prefix, and the empty string
// stays empty (FRONTEND_URL "" keeps today's empty-Location redirect).

describe("trimTrailingSlashes", () => {
  it("leaves a value without a trailing slash unchanged", () => {
    expect(trimTrailingSlashes("http://localhost:3001")).toBe("http://localhost:3001");
  });

  it("removes one trailing slash", () => {
    expect(trimTrailingSlashes("https://panel.example.com/")).toBe("https://panel.example.com");
  });

  it("removes several trailing slashes", () => {
    expect(trimTrailingSlashes("https://panel.example.com///")).toBe("https://panel.example.com");
  });

  it("maps the empty string to the empty string", () => {
    expect(trimTrailingSlashes("")).toBe("");
  });

  it('maps "/" to the empty string', () => {
    expect(trimTrailingSlashes("/")).toBe("");
  });

  it('maps "//" to the empty string', () => {
    expect(trimTrailingSlashes("//")).toBe("");
  });

  it("keeps the path of an origin with a path and trims only its trailing slash", () => {
    expect(trimTrailingSlashes("https://x/panel/")).toBe("https://x/panel");
  });

  it("never removes inner slashes", () => {
    expect(trimTrailingSlashes("https://x/a//b")).toBe("https://x/a//b");
    expect(trimTrailingSlashes("https://x")).toBe("https://x");
  });
});
