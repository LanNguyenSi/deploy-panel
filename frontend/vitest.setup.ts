// NOTE: intentionally NOT `import "@testing-library/jest-dom/vitest"`. This is
// a root npm workspace and @testing-library/jest-dom gets hoisted to the
// repo-root node_modules; its `/vitest` entrypoint does its own internal
// `require("vitest")`, which resolves to whatever vitest copy lives at the
// *root* (the backend workspace's, currently a different resolved version
// than this workspace's local vitest). Two different @vitest/expect
// versions both patching the single shared chai instance breaks unrelated
// matchers repo-wide (observed: `rejects.toThrow()` throwing
// "Cannot read properties of undefined (reading 'indexOf')" even in tests
// that never touch jest-dom). Using the version-agnostic `/matchers` export
// and extending *this* file's own `expect` (resolved from this workspace)
// avoids loading a second vitest instance entirely.
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);
