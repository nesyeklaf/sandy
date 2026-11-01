import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveDevInstanceConfig,
  resolveInheritedDevSkillsRootPaths,
  toDevProcessEnv,
} from "@sandy/config/runtime";
import { makeTempDir } from "@sandy/test-helpers";
import {
  createStartWorktreeCommand,
  resolveDevLaunchMode,
  toDevLaunchProcessEnv,
} from "../src/commands/run-dev.js";
import { migrateLegacyDevData } from "../src/lib/legacy-dev-data-migration.js";
import {
  expectedDevDataDir,
  expectedDevInstanceId,
  expectedDevPorts,
  expectedDevServerUrl,
} from "./dev-instance-expectations.js";

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await fs.access(pathToCheck);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run-dev", () => {
  it("derives stable data and ports from a managed checkout", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/.sandy-dev/projects/env_q7e5i54kxt/sandy";
    const config = resolveDevInstanceConfig({ homeDir, repoRoot });

    expect(config.instanceId).toBe(
      expectedDevInstanceId({ homeDir, repoRoot }),
    );
    expect(config.dataDir).toBe(expectedDevDataDir({ homeDir, repoRoot }));
    expect(config.ports).toEqual(expectedDevPorts(repoRoot));
    expect(config.serverUrl).toBe(expectedDevServerUrl(repoRoot));
    expect(new Set(Object.values(config.ports))).toHaveLength(3);
    expect(Object.values(config.ports)).not.toContain(5173);
    expect(Object.values(config.ports)).not.toContain(3334);
    expect(Object.values(config.ports)).not.toContain(3002);
    expect(Object.values(config.ports)).not.toContain(38886);
    expect(Object.values(config.ports)).not.toContain(38887);
  });

  it("uses the home-relative checkout path for non-managed checkout paths", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/src/work/sandy-feature-copy";

    const config = resolveDevInstanceConfig({ homeDir, repoRoot });

    expect(config.instanceId).toBe(
      expectedDevInstanceId({ homeDir, repoRoot }),
    );
  });

  it("overrides instance selectors while preserving unrelated environment", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/.sandy-dev/projects/env_q7e5i54kxt/sandy",
    });
    const baseEnv: NodeJS.ProcessEnv = {
      SANDY_DATA_DIR: "/Users/tester/.sandy-dev",
      SANDY_SERVER_PORT: "3334",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    };

    const env = toDevProcessEnv({ baseEnv, config });

    expect(env.OPENAI_API_KEY).toBe("test-key");
    expect(env.NODE_ENV).toBe("development");
    expect(env.SANDY_DATA_DIR).toBe(config.dataDir);
    expect(env.SANDY_SERVER_PORT).toBe(String(config.ports.serverPort));
    expect(env.SANDY_SERVER_URL).toBe(config.serverUrl);
    expect(env.SANDY_HOST_DAEMON_PORT).toBe(String(config.ports.hostDaemonPort));
    expect(env.SANDY_DEV_APP_PORT).toBe(String(config.ports.appPort));
  });

  it("inherits parent sandy skills for managed worktree dev apps", () => {
    const homeDir = path.resolve("/Users/tester");
    const repoRoot = path.join(
      homeDir,
      ".sandy-dev/code-sandy-abc123/worktrees/env_feature/sandy",
    );
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot,
    });

    const inheritedSkillsRootPaths = [
      path.join(homeDir, ".sandy-dev", "code-sandy-abc123", "skills"),
      path.join(homeDir, ".sandy", "skills"),
    ];
    expect(resolveInheritedDevSkillsRootPaths({ homeDir, repoRoot })).toEqual(
      inheritedSkillsRootPaths,
    );
    expect(toDevProcessEnv({ baseEnv: {}, config })).toMatchObject({
      SANDY_INHERITED_SKILLS_ROOTS: inheritedSkillsRootPaths.join(path.delimiter),
    });
  });

  it("dedupes inherited sandy skills for prod-managed worktree dev apps", () => {
    const homeDir = path.resolve("/Users/tester");
    const repoRoot = path.join(homeDir, ".sandy/worktrees/env_feature/sandy");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot,
    });

    expect(resolveInheritedDevSkillsRootPaths({ homeDir, repoRoot })).toEqual([
      path.join(homeDir, ".sandy", "skills"),
    ]);
    expect(toDevProcessEnv({ baseEnv: {}, config })).toMatchObject({
      SANDY_INHERITED_SKILLS_ROOTS: path.join(homeDir, ".sandy", "skills"),
    });
  });

  it("inherits prod sandy skills for ordinary checkout dev apps", () => {
    const homeDir = path.resolve("/Users/tester");
    const repoRoot = path.join(homeDir, "src", "sandy");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot,
    });

    expect(resolveInheritedDevSkillsRootPaths({ homeDir, repoRoot })).toEqual([
      path.join(homeDir, ".sandy", "skills"),
    ]);
    expect(toDevProcessEnv({ baseEnv: {}, config })).toMatchObject({
      SANDY_INHERITED_SKILLS_ROOTS: path.join(homeDir, ".sandy", "skills"),
    });
  });

  it("strips parent thread context from dev child processes", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/sandy",
    });
    const baseEnv: NodeJS.ProcessEnv = {
      SANDY_ENVIRONMENT_ID: "env_parent",
      SANDY_PROJECT_ID: "proj_parent",
      SANDY_THREAD_ID: "thr_parent",
      SANDY_THREAD_STORAGE: "/Users/tester/.sandy/thread-storage/thr_parent",
    };

    const env = toDevProcessEnv({ baseEnv, config });

    expect(env.SANDY_ENVIRONMENT_ID).toBeUndefined();
    expect(env.SANDY_THREAD_ID).toBeUndefined();
    expect(env.SANDY_THREAD_STORAGE).toBeUndefined();
    expect(env.SANDY_PROJECT_ID).toBe("proj_parent");
  });

  it("passes the account pool marker to a nested dev server", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/sandy",
    });
    const baseEnv: NodeJS.ProcessEnv = {
      SANDY_ACCOUNT_POOL_PARENT_URL:
        "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
      SANDY_ACCOUNT_POOL_PARENT_TOKEN: "parent-hub-token",
      ANTHROPIC_BASE_URL:
        "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
      ANTHROPIC_AUTH_TOKEN: "parent-hub-token",
    };

    const env = toDevProcessEnv({ baseEnv, config });

    expect(env.SANDY_ACCOUNT_POOL_PARENT_URL).toBe(
      "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
    );
    expect(env.SANDY_ACCOUNT_POOL_PARENT_TOKEN).toBe("parent-hub-token");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("parent-hub-token");
    expect(env.SANDY_SERVER_URL).toBe(config.serverUrl);
  });

  it("runs the production-style source launcher for worktree start", () => {
    const command = createStartWorktreeCommand();
    expect(createStartWorktreeCommand(false, true).args).toContain(
      "--perf-diagnostics",
    );

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      "--conditions=source",
      "--import",
      "tsx",
      path.resolve(import.meta.dirname, "../../..", "scripts/start-sandy.mjs"),
      "--worktree-runtime-policy",
    ]);
  });

  it("accepts only the supported dev launch mode", () => {
    expect(resolveDevLaunchMode([])).toBe("vite");
    expect(resolveDevLaunchMode(["--worktree"])).toBe("worktree");
    expect(() => resolveDevLaunchMode(["--watch"])).toThrow(
      "Expected no arguments or --worktree",
    );
  });

  it.each(["vite", "worktree"] as const)(
    "preserves an explicit onboarding override in %s mode",
    (mode) => {
      const config = resolveDevInstanceConfig({
        homeDir: "/Users/tester",
        repoRoot: "/Users/tester/src/sandy",
      });
      const env = toDevLaunchProcessEnv({
        baseEnv: { SANDY_SKIP_ONBOARDING: "0" },
        config,
        mode,
      });

      expect(env.SANDY_SKIP_ONBOARDING).toBe("0");
    },
  );

  it("uses production serving with checkout-specific dev selectors", () => {
    const config = resolveDevInstanceConfig({
      homeDir: "/Users/tester",
      repoRoot: "/Users/tester/src/sandy",
    });

    const env = toDevLaunchProcessEnv({
      baseEnv: {
        SANDY_DATA_DIR: "/Users/tester/.sandy",
        SANDY_DEV_APP_PORT: "5173",
        NODE_ENV: "development",
        OPENAI_API_KEY: "test-key",
      },
      config,
      mode: "worktree",
    });

    expect(env).toMatchObject({
      SANDY_DATA_DIR: config.dataDir,
      SANDY_HOST_DAEMON_PORT: String(config.ports.hostDaemonPort),
      SANDY_SERVER_PORT: String(config.ports.serverPort),
      SANDY_SERVER_URL: config.serverUrl,
      SANDY_SKIP_ONBOARDING: "1",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    });
    expect(env.SANDY_DEV_APP_PORT).toBeUndefined();
  });

  it("migrates legacy flat dev data into the checkout instance", async () => {
    const homeDir = await makeTempDir("sandy-dev-home-");
    const legacyDataDir = path.join(homeDir, ".sandy-dev");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot: path.join(homeDir, "src", "sandy"),
    });
    await fs.mkdir(path.join(legacyDataDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(legacyDataDir, "attachments", "proj_test"), {
      recursive: true,
    });
    await fs.mkdir(path.join(legacyDataDir, "worktrees", "env_old", "sandy"), {
      recursive: true,
    });
    await fs.mkdir(path.join(legacyDataDir, "dev-supervisors"), {
      recursive: true,
    });
    await fs.writeFile(path.join(legacyDataDir, "sandy.db"), "db", "utf8");
    await fs.writeFile(
      path.join(legacyDataDir, "sandy.db.backup-20260515-160305"),
      "backup",
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyDataDir, "auth-secret"),
      "secret",
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyDataDir, "attachments", "proj_test", "screenshot.png"),
      "image",
      "utf8",
    );
    await fs.writeFile(path.join(legacyDataDir, "daemon.lock"), "lock", "utf8");
    await fs.writeFile(
      path.join(legacyDataDir, "dev-supervisors", "server.pid"),
      "not-a-pid",
      "utf8",
    );
    const output = { write: vi.fn() };

    const result = await migrateLegacyDevData({ config, output });

    expect(result).toEqual({
      migratedEntries: [
        "attachments",
        "auth-secret",
        "logs",
        "sandy.db",
        "sandy.db.backup-20260515-160305",
      ],
    });
    await expect(
      fs.readFile(path.join(config.dataDir, "sandy.db"), "utf8"),
    ).resolves.toBe("db");
    await expect(
      fs.readFile(path.join(config.dataDir, "auth-secret"), "utf8"),
    ).resolves.toBe("secret");
    await expect(
      fs.readFile(
        path.join(config.dataDir, "attachments", "proj_test", "screenshot.png"),
        "utf8",
      ),
    ).resolves.toBe("image");
    await expect(
      fs.access(path.join(legacyDataDir, "worktrees", "env_old", "sandy")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(legacyDataDir, "dev-supervisors", "server.pid")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(legacyDataDir, "daemon.lock")),
    ).resolves.toBeUndefined();
    expect(output.write).toHaveBeenCalledWith(
      expect.stringContaining(
        `Migrated legacy dev data into ${config.dataDir}`,
      ),
    );
  });

  it("skips migration when the target instance already has data", async () => {
    const homeDir = await makeTempDir("sandy-dev-home-");
    const legacyDataDir = path.join(homeDir, ".sandy-dev");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot: path.join(homeDir, "src", "sandy"),
    });
    await fs.mkdir(legacyDataDir, { recursive: true });
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(path.join(legacyDataDir, "sandy.db"), "legacy", "utf8");
    await fs.writeFile(path.join(config.dataDir, "sandy.db"), "target", "utf8");

    await expect(migrateLegacyDevData({ config })).resolves.toEqual({
      migratedEntries: [],
      skippedReason: "target-exists",
    });
    await expect(
      fs.readFile(path.join(legacyDataDir, "sandy.db"), "utf8"),
    ).resolves.toBe("legacy");
    await expect(
      fs.readFile(path.join(config.dataDir, "sandy.db"), "utf8"),
    ).resolves.toBe("target");
  });

  it("skips migration when legacy dev data is absent", async () => {
    const homeDir = await makeTempDir("sandy-dev-home-");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot: path.join(homeDir, "src", "sandy"),
    });

    await expect(migrateLegacyDevData({ config })).resolves.toEqual({
      migratedEntries: [],
      skippedReason: "legacy-data-not-found",
    });
    expect(await pathExists(config.dataDir)).toBe(false);
  });

  it("skips migration when legacy dev data has no migratable entries", async () => {
    const homeDir = await makeTempDir("sandy-dev-home-");
    const legacyDataDir = path.join(homeDir, ".sandy-dev");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot: path.join(homeDir, "src", "sandy"),
    });
    await fs.mkdir(legacyDataDir, { recursive: true });
    await fs.writeFile(path.join(legacyDataDir, "daemon.lock"), "lock", "utf8");

    await expect(migrateLegacyDevData({ config })).resolves.toEqual({
      migratedEntries: [],
      skippedReason: "legacy-data-empty",
    });
    expect(await pathExists(config.dataDir)).toBe(false);
  });

  it("rolls back already moved entries when migration rename fails", async () => {
    const homeDir = await makeTempDir("sandy-dev-home-");
    const legacyDataDir = path.join(homeDir, ".sandy-dev");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot: path.join(homeDir, "src", "sandy"),
    });
    await fs.mkdir(legacyDataDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDataDir, "auth-secret"),
      "secret",
      "utf8",
    );
    await fs.writeFile(path.join(legacyDataDir, "sandy.db"), "db", "utf8");
    const renameCalls: string[] = [];
    const renameWithInjectedFailure = vi.fn(
      async (sourcePath: string, targetPath: string): Promise<void> => {
        renameCalls.push(path.basename(sourcePath));
        if (renameCalls.length === 1) {
          await fs.rename(sourcePath, targetPath);
          return;
        }

        throw new Error("injected rename failure");
      },
    );

    await expect(
      migrateLegacyDevData({
        config,
        dependencies: {
          rename: renameWithInjectedFailure,
        },
      }),
    ).rejects.toThrow("injected rename failure");

    expect(renameCalls).toEqual(["auth-secret", "sandy.db"]);
    await expect(
      fs.readFile(path.join(legacyDataDir, "auth-secret"), "utf8"),
    ).resolves.toBe("secret");
    await expect(
      fs.readFile(path.join(legacyDataDir, "sandy.db"), "utf8"),
    ).resolves.toBe("db");
    expect(await pathExists(config.dataDir)).toBe(false);
  });

  it("does not migrate legacy data while a legacy dev supervisor is running", async () => {
    const homeDir = await makeTempDir("sandy-dev-home-");
    const legacyDataDir = path.join(homeDir, ".sandy-dev");
    const config = resolveDevInstanceConfig({
      homeDir,
      repoRoot: path.join(homeDir, "src", "sandy"),
    });
    await fs.mkdir(path.join(legacyDataDir, "dev-supervisors"), {
      recursive: true,
    });
    await fs.writeFile(path.join(legacyDataDir, "sandy.db"), "db", "utf8");
    await fs.writeFile(
      path.join(legacyDataDir, "dev-supervisors", "server.pid"),
      `${process.pid}\n`,
      "utf8",
    );

    await expect(migrateLegacyDevData({ config })).resolves.toEqual({
      migratedEntries: [],
      skippedReason: "legacy-dev-process-running",
    });
    await expect(
      fs.readFile(path.join(legacyDataDir, "sandy.db"), "utf8"),
    ).resolves.toBe("db");
    expect(await pathExists(config.dataDir)).toBe(false);
  });
});
