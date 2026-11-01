import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    include: ["test/**/*.test.ts"],
    name: "@sandy/qa",
    testTimeout: 15_000,
  },
});
