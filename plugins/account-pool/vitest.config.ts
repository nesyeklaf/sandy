import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    execArgv:
      Number(process.versions.node.split(".")[0]) >= 25
        ? ["--no-webstorage"]
        : [],
    name: "sandy-plugin-account-pool",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
