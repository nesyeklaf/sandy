import { defineConfig } from "vitest/config";
import { WEB_STORAGE_EXEC_ARGV } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    execArgv: WEB_STORAGE_EXEC_ARGV,
    silent: "passed-only",
    name: "sandy-plugin-scheduled-send",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
