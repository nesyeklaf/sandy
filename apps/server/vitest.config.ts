import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 15_000,
    globalSetup: ["test/setup/migrated-db-template.ts"],
    setupFiles: [
      "test/setup/stored-event-decode-freeze.ts",
      "test/setup/warm-test-harness.ts",
    ],
    env: {
      SANDY_DATA_DIR: "/tmp/sandy-server-test",
      SANDY_SERVER_PORT: "49161",
      SANDY_HOST_DAEMON_PORT: "49162",
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@sandy/server",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    }),
  },
});
