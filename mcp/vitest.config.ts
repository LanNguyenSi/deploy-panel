import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      // vitest 4 reports every `include`-matched file (the old `all:true`
      // behavior is now the default), so a NEW untested file lowers coverage.
      include: ["src/**/*.ts"],
      // Exclude test files, the side-effecting bin entrypoint (thin wrapper:
      // loadConfig + startServer + process.exit on fatal error), and dist.
      exclude: ["**/*.test.ts", "src/index.ts", "**/dist/**"],
      reporter: ["text", "text-summary"],
      // Per-file floors set a few points below the 2026-07-04 measured
      // baseline (every src file is 100/100/100/100) for the files that
      // carry real logic: tools.ts/client.ts (request construction — a
      // swapped server/app arg would deploy or roll back the WRONG app),
      // config.ts (env loading + the process.exit(1) guard on a missing
      // var), and server.ts (McpServer/DeployPanelClient/registerTools/
      // stdio-transport wiring). With config.ts and server.ts now covered,
      // the global floor is raised to the same ~95 level rather than the
      // old whole-src baseline. Raise these as coverage improves; a
      // regression here should fail CI, not erode silently.
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 95,
        "src/tools.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        "src/client.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        "src/config.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        "src/server.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
      },
    },
  },
});
