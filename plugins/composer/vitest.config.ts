import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "sandy-plugin-sandy--composer",
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["./test-setup.ts"],
    exclude: ["node_modules/**"],
  },
});
