import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    env: {
      SANDY_DATA_DIR: "/tmp/sandy-host-daemon-test",
      SANDY_SERVER_URL: "http://127.0.0.1:49161",
      SANDY_HOST_DAEMON_PORT: "49162",
    },
    testTimeout: 15_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@sandy/host-daemon",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    }),
  },
});
