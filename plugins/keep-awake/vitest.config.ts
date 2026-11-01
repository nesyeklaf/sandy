import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "sandy-plugin-keep-awake",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
