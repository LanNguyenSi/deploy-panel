import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors tsconfig.json's `paths: { "@/*": ["./src/*"] }`.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      // vitest 4 reports every `include`-matched file (the old `all:true`
      // behavior is now the default), so a NEW untested file lowers coverage.
      //
      // Scoped to what this slice actually tests: all of src/lib/** (the
      // pure request-construction + status-badge logic) and the single
      // ConfirmDialog component that gates every destructive action
      // (deploy/rollback/hide/delete) behind a confirm dialog. The much
      // larger page/dialog component surface (ServerInstallWizard,
      // ScheduleDialog, EnvVarsPanel, …) is intentionally out of scope for
      // this slice — including it here would drown the gate in untested
      // JSX rather than guard the behavior this slice covers. A follow-up
      // slice can widen `include` and raise these floors as it lands.
      //
      // Note: src/lib/notifications.ts and src/lib/pinned.ts (browser
      // Notification API / localStorage wrappers) are matched by
      // `src/lib/**` but are NOT tested by this slice either — they are
      // included here (rather than carved out) to keep the coverage
      // denominator honest, and the global floor below is calibrated to
      // account for their 0% contribution.
      include: ["src/lib/**", "src/components/ConfirmDialog.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.d.ts"],
      reporter: ["text", "text-summary"],
      // Per-file floors set a few points below the 2026-07-01 measured
      // baseline for the three files this slice actually drives to high
      // coverage. api.ts's floor is calibrated to the *covered subset*:
      // the sseStream()-based SSE async generators (installRelayStream,
      // reinstallRelayStream, updateRelayImageStream) and probeVps() need
      // a streaming/ReadableStream test harness that is out of scope here
      // and are left uncovered on purpose — see api.test.ts header comment.
      // Measured 2026-07-01 (npm run test --workspace=frontend):
      //   global (whole include scope): lines 26.61 / stmts 23.78 / funcs 36.5 / branches 21.73
      //   src/lib/status.ts:            lines 100   / stmts 100   / funcs 100  / branches 100
      //   src/lib/api.ts (covered subset, SSE generators + probeVps excluded):
      //                                  lines 22.22 / stmts 20.19 / funcs 30.76 / branches 20.37
      //   src/components/ConfirmDialog.tsx: lines 100 / stmts 94.11 / funcs 90.9 / branches 87.5
      // notifications.ts and pinned.ts sit at 0/0/0/0 (untested, see note above) and pull the
      // global floor down along with api.ts's uncovered SSE surface; per-file floors below carry
      // the real signal. Floors are set a few points below each measured value; raise as coverage
      // improves. A regression here should fail CI, not erode silently.
      thresholds: {
        lines: 24,
        statements: 21,
        functions: 33,
        branches: 19,
        "src/lib/status.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        "src/lib/api.ts": {
          lines: 20,
          statements: 18,
          functions: 28,
          branches: 18,
        },
        "src/components/ConfirmDialog.tsx": {
          lines: 95,
          statements: 90,
          functions: 85,
          branches: 80,
        },
      },
    },
  },
});
