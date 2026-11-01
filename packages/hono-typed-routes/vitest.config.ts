import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "@sandy/hono-typed-routes",
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
