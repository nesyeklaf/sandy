import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "sandy-plugin-provider-codex",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
