import { defineConfig } from "vitest/config";
import { WEB_STORAGE_EXEC_ARGV } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    execArgv: WEB_STORAGE_EXEC_ARGV,
    name: "sandy-plugin-account-pool",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
