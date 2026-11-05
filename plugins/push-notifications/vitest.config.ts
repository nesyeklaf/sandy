import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    execArgv:
      Number(process.versions.node.split(".")[0]) >= 25
        ? ["--no-webstorage"]
        : [],
    silent: "passed-only",
    name: "sandy-plugin-push-notifications",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
