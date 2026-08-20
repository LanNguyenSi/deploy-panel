import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Node >=22.4 (unflagged on Node 26) ships a native global `localStorage`
// accessor that is non-functional without `--localstorage-file`. vitest's
// jsdom environment only replaces a host global when it is missing or on the
// DOM-class allowlist, and `localStorage` is neither (vitest-dev/vitest#8757),
// so `window.localStorage.*` throws "Cannot read properties of undefined" in
// jsdom tests. Disabling the experimental implementation hands the global back
// to jsdom. The capability guard is load-bearing: Node 20 aborts with
// `bad option` on an unknown flag, and a future flag rename degrades to a
// no-op instead of breaking the suite.
const execArgv = process.allowedNodeEnvironmentFlags.has(
  "--no-experimental-webstorage",
)
  ? ["--no-experimental-webstorage"]
  : [];

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
    execArgv,
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
      include: ["src/lib/**", "src/components/ConfirmDialog.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.d.ts"],
      reporter: ["text", "text-summary"],
      // Per-file floors set a few points below the 2026-07-04 measured
      // baseline (previous baseline was 2026-07-01; see git history for
      // that slice's numbers). This slice added: exact-request tests for
      // the remaining destructive api.ts functions (revokeApiKey,
      // cancelScheduledDeploy, testServer, syncServer, scheduleDeploy,
      // createApiKey — see api.test.ts); a ReadableStream-mock harness
      // covering the SSE async generators (installRelayStream,
      // reinstallRelayStream, updateRelayImageStream) and probeVps() (see
      // api.sse.test.ts); and full coverage of notifications.ts and
      // pinned.ts (see notifications.test.ts / pinned.test.ts).
      //
      // notifications.ts hits 100/100/100/100 by stubbing `window.Notification`
      // with a fake class via vi.stubGlobal — jsdom itself doesn't implement
      // the Notification API. pinned.ts hits 100% lines/functions but not
      // 100% branches/statements: its `typeof window === "undefined"` SSR
      // guard in getPinnedApps() can't be exercised from a jsdom test
      // environment (window is always defined there) and is left uncovered
      // on purpose.
      //
      // api.ts's remaining gap (~27-40 points below 100 depending on metric)
      // is the plain GET wrappers (getServers, getApps, getAppLogs, etc.) —
      // out of scope for this slice, which targeted destructive/mutating
      // functions and the SSE/probe surface specifically.
      //
      // src/lib/rollback.ts measured 100/100/100/100 (2026-08-20, review-fix
      // round on task b5029d90) after adding the blocked-with-missing/empty-
      // checks and all-checks-passing edge-case tests in rollback.test.ts.
      //
      // Measured 2026-07-04 (npm run test --workspace=frontend):
      //   global (whole include scope): lines 82.73 / stmts 78.65 / funcs 76.19 / branches 73.91
      //   src/lib/status.ts:            lines 100   / stmts 100   / funcs 100   / branches 100
      //   src/lib/notifications.ts:     lines 100   / stmts 100   / funcs 100   / branches 100
      //   src/lib/pinned.ts:            lines 100   / stmts 94.11 / funcs 100   / branches 90
      //   src/lib/api.ts:                lines 73.33 / stmts 68.26 / funcs 64.1 / branches 59.25
      //   src/components/ConfirmDialog.tsx: lines 100 / stmts 94.11 / funcs 90.9 / branches 87.5
      //
      // Floors below are calibrated TIGHT (not just "a few points below"):
      // dropping the coverage of any single one of the newly-added
      // destructive-function tests must fail this gate. Verified via a
      // negative control: skipping the revokeApiKey test alone drops
      // api.ts to lines 72.22 / stmts 67.3 / funcs 61.53 (branches
      // unchanged at 59.25, since that function has no branches) and the
      // global scope to lines 82.01 / stmts 78.04 / funcs 74.6 — each
      // below its respective floor below, while the full (all-tests-passing)
      // numbers above clear every floor. A regression here fails CI, not
      // erodes silently.
      thresholds: {
        lines: 82.5,
        statements: 78.5,
        functions: 75,
        branches: 73,
        "src/lib/status.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        "src/lib/notifications.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        "src/lib/pinned.ts": {
          lines: 100,
          statements: 90,
          functions: 100,
          branches: 85,
        },
        "src/lib/api.ts": {
          lines: 73,
          statements: 68,
          functions: 64,
          branches: 59,
        },
        "src/components/ConfirmDialog.tsx": {
          lines: 95,
          statements: 90,
          functions: 85,
          branches: 80,
        },
        "src/lib/rollback.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
  },
});
