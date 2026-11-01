import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "sandy-plugin-provider-claude-code",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
