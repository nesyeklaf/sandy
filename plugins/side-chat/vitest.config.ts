import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "sandy-plugin-side-chat",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
