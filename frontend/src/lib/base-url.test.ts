import { afterEach, describe, expect, it, vi } from "vitest";

// Contract of the single API-origin assembly point (frontend/src/lib/base-url.ts):
// only trailing slashes are trimmed (an origin with a path prefix keeps the
// prefix), an empty value stays empty so consumers build relative same-origin
// URLs, and an unset value falls back to the localhost default. The API_BASE
// cases re-import the module (vi.resetModules + dynamic import) because the
// constant is read from process.env at module scope.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("trimTrailingSlashes", () => {
  it("leaves a value without a trailing slash unchanged", async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("http://localhost:3001")).toBe("http://localhost:3001");
  });

  it("removes one trailing slash", async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("https://panel.example.com/")).toBe("https://panel.example.com");
  });

  it("removes several trailing slashes", async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("https://panel.example.com///")).toBe("https://panel.example.com");
  });

  it("maps the empty string to the empty string (relative URLs stay relative)", async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("")).toBe("");
  });

  it('maps "/" to the empty string', async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("/")).toBe("");
  });

  it('maps "//" to the empty string', async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("//")).toBe("");
  });

  it("keeps the path of an origin with a path and trims only its trailing slash", async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("https://x/panel/")).toBe("https://x/panel");
  });

  it("never removes inner slashes", async () => {
    const { trimTrailingSlashes } = await import("./base-url");
    expect(trimTrailingSlashes("https://x/a//b")).toBe("https://x/a//b");
    expect(trimTrailingSlashes("https://x")).toBe("https://x");
  });
});

describe("API_BASE (NEXT_PUBLIC_API_URL read at module load)", () => {
  it("is the localhost default when NEXT_PUBLIC_API_URL is unset", async () => {
    expect(process.env.NEXT_PUBLIC_API_URL).toBeUndefined();
    const { API_BASE } = await import("./base-url");
    expect(API_BASE).toBe("http://localhost:3001");
  });

  it("trims trailing slashes of a configured value", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://panel.example.com//");
    const { API_BASE } = await import("./base-url");
    expect(API_BASE).toBe("https://panel.example.com");
  });

  it("stays empty for an empty NEXT_PUBLIC_API_URL (relative same-origin URLs)", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const { API_BASE } = await import("./base-url");
    expect(API_BASE).toBe("");
  });
});

describe("api.ts request wiring", () => {
  it("builds request URLs with a single slash before /api when the env value ends in slashes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://backend.test/");
    vi.resetModules();
    const api = await import("./api");

    await api.getHealth();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.test/api/health",
      expect.objectContaining({ credentials: "include" }),
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain("//api");
  });
});
