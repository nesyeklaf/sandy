import { defineWorkspaceTestConfig } from "../../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "sandy-plugin-slack-bot",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
