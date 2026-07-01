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
      // Per-file floors set a few points below the 2026-07-01 measured
      // baseline (tools.ts and client.ts are both 100/100/100/100) for the
      // two files that carry the real safety logic — request construction —
      // a swapped server/app arg would deploy or roll back the WRONG app.
      // config.ts and server.ts have no tests yet (config.ts calls
      // process.exit on missing env vars; server.ts is the stdio transport
      // wiring), so the global floor is calibrated to the whole-src measured
      // baseline (lines 80 / statements 80.82 / functions 90.9 / branches
      // 80) rather than to tools.ts/client.ts alone, set ~1 point below so a
      // new untested file trips the gate while leaving a small buffer against
      // noise. Raise these as coverage improves; a regression here should
      // fail CI, not erode silently.
      thresholds: {
        lines: 79,
        statements: 79,
        functions: 89,
        branches: 79,
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
      },
    },
  },
});
