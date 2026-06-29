import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // vitest 4 reports every `include`-matched file (the old `all:true`
      // behavior is now the default), so a NEW untested file lowers coverage.
      include: ["src/**/*.ts"],
      // Exclude type decls, the side-effecting server entrypoint, and the
      // config module (it validates env + process.exit at import).
      exclude: ["src/**/*.d.ts", "src/server.ts", "src/config/**"],
      reporter: ["text-summary"],
      // Whole-src ratchet locked just below the 2026-06-29 measured baseline
      // (lines 60.1 / stmts 58.3 / funcs 56.7 / branches 54.6). all:true means a
      // NEW untested file lowers coverage below the floor, not just erosion of
      // already-tested files. Raise these as coverage improves.
      thresholds: {
        lines: 55,
        statements: 53,
        functions: 52,
        branches: 50,
      },
    },
  },
});
