import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const appTests = [
  "src/ThreadInbox.*.test.tsx",
  "src/ParentChip.test.tsx",
  "src/SubagentsChip.test.tsx",
  "src/ProjectFavicon.test.tsx",
  "src/app-worker-state.*.test.tsx",
];
const common = {
  silent: "passed-only" as const,
  testTimeout: 30_000,
  setupFiles: ["./src/test-setup.ts"],
  // Node 25+ turns on its own Web Storage, whose localStorage shadows jsdom's (vitest-dev/vitest#8757).
  // Older Node does not know the flag, so it is passed only where the collision exists.
  execArgv: Number(process.versions.node.split(".")[0]) >= 25 ? ["--no-webstorage"] : [],
};

export default defineConfig({
  resolve: {
    // Load the real SVG data through leaf exports instead of the full barrel.
    alias: [
      {
        find: /^@hugeicons\/core-free-icons$/,
        replacement: fileURLToPath(new URL("./src/test-icon-data.ts", import.meta.url)),
      },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...common,
          name: "app",
          environment: "jsdom",
          include: appTests,
          isolate: true,
          setupFiles: [...common.setupFiles, "./src/test-app-setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          ...common,
          name: "isolated",
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["node_modules/**", ...appTests],
        },
      },
    ],
  },
});
