import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@sandy/provider-bridge-protocol",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    }),
  },
});
