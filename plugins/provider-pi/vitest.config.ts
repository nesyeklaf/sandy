import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "sandy-plugin-provider-pi",
    include: ["*.test.ts", "*.test.tsx", "src/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
