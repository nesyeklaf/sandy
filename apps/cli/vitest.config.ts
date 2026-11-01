import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 15_000,
    env: {
      SANDY_SERVER_URL: "http://127.0.0.1:49161",
      SANDY_HOST_DAEMON_PORT: "49162",
      SANDY_CLI_ERROR_LOG: "0",
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@sandy/cli",
      include: ["src/**/*.test.ts"],
    }),
  },
});
