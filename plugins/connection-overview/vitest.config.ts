import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  test: {
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "sandy-plugin-sandy--connection-overview",
      include: ["**/*.test.{ts,tsx}"],
    }),
  },
});
