import { defineConfig } from "vitest/config";
import { WEB_STORAGE_EXEC_ARGV } from "../../vitest.shared.js";

export default defineConfig({
  test: {
    execArgv: WEB_STORAGE_EXEC_ARGV,
    silent: "passed-only",
    name: "sandy-plugin-push-notifications",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
