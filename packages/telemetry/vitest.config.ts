import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "@sandy/telemetry",
    testTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
