import { defineConfig } from "vitest/config";

// The entry test of the merged plugin; each part runs its own tests (see package.json).
export default defineConfig({
  test: { name: "sandy-plugin-work", environment: "node", testTimeout: 15_000, include: ["server.test.ts", "app.test.tsx", "goals/banner.test.tsx"] }, resolve: { tsconfigPaths: true },
});
