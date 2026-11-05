import { defineConfig } from "vitest/config";
import { WEB_STORAGE_EXEC_ARGV } from "../../vitest.shared.js";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "tippy.js": "tippy.js/dist/tippy.esm.js",
    },
  },
  test: {
    execArgv: WEB_STORAGE_EXEC_ARGV,
    silent: "passed-only",
    name: "sandy-plugin-tasks",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    testTimeout: 20_000,
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        inline: ["@tiptap/extension-bubble-menu"],
      },
    },
  },
});
