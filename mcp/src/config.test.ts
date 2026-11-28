import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

// process.exit(1) really tears down the process; stub it to throw instead so
// a call site can neither swallow it nor keep running past it (matches real
// process.exit's control-flow effect without killing the test worker).
function stubExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loadConfig", () => {
  it("returns { apiUrl, apiKey } read straight from the environment", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", "https://panel.example.com");
    vi.stubEnv("DEPLOY_PANEL_API_KEY", "secret-key");

    expect(loadConfig()).toEqual({ apiUrl: "https://panel.example.com", apiKey: "secret-key" });
  });

  it("strips a single trailing slash from DEPLOY_PANEL_URL", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", "https://panel.example.com/");
    vi.stubEnv("DEPLOY_PANEL_API_KEY", "secret-key");

    expect(loadConfig().apiUrl).toBe("https://panel.example.com");
  });

  // The source regex is `/\/+$/`: it removes a whole run of trailing
  // slashes, matching the backend's trimTrailingSlashes (src/lib/origin.ts),
  // so a configured "https://panel.example.com//" never reaches the API as
  // "...//api/...".
  it("strips repeated trailing slashes", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", "https://panel.example.com//");
    vi.stubEnv("DEPLOY_PANEL_API_KEY", "secret-key");

    expect(loadConfig().apiUrl).toBe("https://panel.example.com");
  });

  it("strips a run of three trailing slashes", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", "https://panel.example.com///");
    vi.stubEnv("DEPLOY_PANEL_API_KEY", "secret-key");

    expect(loadConfig().apiUrl).toBe("https://panel.example.com");
  });

  // Only TRAILING slashes go: a URL configured with a path prefix keeps it.
  it("keeps an inner path when trimming trailing slashes", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", "https://x/panel/");
    vi.stubEnv("DEPLOY_PANEL_API_KEY", "secret-key");

    expect(loadConfig().apiUrl).toBe("https://x/panel");
  });

  it("logs to stderr and exits with code 1 when DEPLOY_PANEL_URL is missing", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", undefined);
    vi.stubEnv("DEPLOY_PANEL_API_KEY", "secret-key");
    const exitSpy = stubExit();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadConfig()).toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith("DEPLOY_PANEL_URL environment variable is required");
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("logs to stderr and exits with code 1 when DEPLOY_PANEL_API_KEY is missing", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", "https://panel.example.com");
    vi.stubEnv("DEPLOY_PANEL_API_KEY", undefined);
    const exitSpy = stubExit();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadConfig()).toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith("DEPLOY_PANEL_API_KEY environment variable is required");
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("exits on the missing URL before ever checking the API key", () => {
    vi.stubEnv("DEPLOY_PANEL_URL", undefined);
    vi.stubEnv("DEPLOY_PANEL_API_KEY", undefined);
    const exitSpy = stubExit();
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadConfig()).toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
  });
});
