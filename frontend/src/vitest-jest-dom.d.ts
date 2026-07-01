// Type-only augmentation: brings jest-dom's matcher types (toBeInTheDocument,
// toHaveClass, toHaveTextContent, …) onto vitest's `Assertion` interface for
// tsc, WITHOUT importing `@testing-library/jest-dom/vitest` at runtime (see
// vitest.setup.ts for why: that entrypoint's own internal `require("vitest")`
// resolves to a different hoisted vitest copy in this root workspace and
// breaks unrelated matchers at runtime).
//
// Deliberately mirrors jest-dom's own types/vitest.d.ts by hand instead of
// importing it directly: `import "vitest"` here resolves relative to THIS
// file (frontend/src/…), i.e. frontend's own local vitest install — the
// same module identity our test files import from — so the declaration
// merge actually lands on the `Assertion` interface tsc uses when checking
// this workspace. Importing jest-dom's copy (which lives in the hoisted
// root node_modules) would augment a `vitest` module resolved from root
// instead, which tsc would treat as a different type identity here.
import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
