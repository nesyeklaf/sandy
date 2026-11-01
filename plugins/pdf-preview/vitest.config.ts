import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "sandy-plugin-pdf-preview",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
