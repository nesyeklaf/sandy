import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_LAUNCHER_MARKER } from "@sandy/config/cli-command";
import {
  formatCliLauncherPath,
  renderCliLauncher,
  resolveCliLauncherTarget,
  writeCliLauncher,
} from "../src/cli-launcher.js";

const execFileAsync = promisify(execFile);
const posixIt = process.platform === "win32" ? it.skip : it;
const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandy-cli-launcher-")));
  scratchDirs.push(dir);
  return dir;
}

const ARGUMENT_ECHO_SCRIPT =
  "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), dataDir: process.env.SANDY_DATA_DIR }));\n";

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe("sandy command launcher", () => {
  posixIt(
    "runs the sandy entry with the install's runtime and passes arguments through unchanged",
    async () => {
      const root = scratchDir();
      const entryPath = join(root, "it's here", "sandy.js");
      mkdirSync(dirname(entryPath));
      writeFileSync(entryPath, ARGUMENT_ECHO_SCRIPT);
      const dataDir = join(root, "data dir");
      const launcherPath = formatCliLauncherPath({
        dataDir,
        platform: process.platform,
      });
      await writeCliLauncher({
        content: renderCliLauncher({
          dataDir,
          platform: process.platform,
          target: {
            electron: false,
            entryPath,
            kind: "direct",
            runtimePath: process.execPath,
          },
        }),
        launcherPath,
      });

      const result = await execFileAsync(
        launcherPath,
        ["thread", "a b", "it's", "$HOME", ""],
        { env: { PATH: "/nonexistent" } },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        args: ["thread", "a b", "it's", "$HOME", ""],
        dataDir,
      });

      const overridden = await execFileAsync(launcherPath, [], {
        env: { SANDY_DATA_DIR: "/elsewhere", PATH: "/nonexistent" },
      });
      expect(JSON.parse(overridden.stdout)).toEqual({
        args: [],
        dataDir: "/elsewhere",
      });
    },
  );

  posixIt(
    "says how to repair the command when the install it points at is gone",
    async () => {
      const root = scratchDir();
      const launcherPath = join(root, "bin", "sandy");
      await writeCliLauncher({
        content: renderCliLauncher({
          dataDir: root,
          platform: process.platform,
          target: {
            electron: false,
            entryPath: join(root, "removed", "sandy.js"),
            kind: "direct",
            runtimePath: process.execPath,
          },
        }),
        launcherPath,
      });

      await expect(
        execFileAsync(launcherPath, ["status"]),
      ).rejects.toMatchObject({
        code: 127,
        stderr:
          "sandy has moved or been removed. Start sandy once to update this command.\n",
      });
    },
  );

  posixIt(
    "runs the entry from the AppImage's own mount without letting AppRun put a sandbox flag before Node's options",
    async () => {
      const root = scratchDir();
      const mountDir = join(root, "mount");
      const entryPath = join(mountDir, "resources", "sandy-app", "dist", "sandy.js");
      writeExecutable(entryPath, ARGUMENT_ECHO_SCRIPT);
      const appImagePath = join(root, "sandy.AppImage");
      writeExecutable(
        appImagePath,
        [
          "#!/bin/sh",
          `export APPDIR='${mountDir}'`,
          'for arg in "$@"; do',
          '  if [ "$arg" = --no-sandbox ]; then',
          `    exec '${process.execPath}' "$@"`,
          "  fi",
          "done",
          `exec '${process.execPath}' --no-sandbox "$@"`,
          "",
        ].join("\n"),
      );
      const target = resolveCliLauncherTarget({
        electron: true,
        env: { APPDIR: join(root, "stale-mount"), APPIMAGE: appImagePath },
        execPath: join(root, "stale-mount", "sandy"),
        packageRoot: join(root, "stale-mount", "resources", "sandy-app"),
        platform: "linux",
      });
      expect(target).toEqual({
        appImagePath,
        entryRelativePath: join("resources", "sandy-app", "dist", "sandy.js"),
        kind: "appimage",
      });
      const launcherPath = join(root, "bin", "sandy");
      await writeCliLauncher({
        content: renderCliLauncher({
          dataDir: join(root, "data"),
          platform: "linux",
          target,
        }),
        launcherPath,
      });

      const result = await execFileAsync(launcherPath, ["thread", "a b"], {
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(JSON.parse(result.stdout)).toEqual({
        args: ["thread", "a b"],
        dataDir: join(root, "data"),
      });
      const noArguments = await execFileAsync(launcherPath, [], {
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(JSON.parse(noArguments.stdout).args).toEqual([]);
    },
  );

  it("runs Electron as Node only for an install that runs inside Electron", () => {
    const base = {
      env: {},
      execPath: "/Applications/sandy.app/Contents/MacOS/sandy",
      packageRoot: "/Applications/sandy.app/Contents/Resources/sandy-app",
      platform: "darwin" as const,
    };
    const electron = renderCliLauncher({
      dataDir: "/Users/me/.sandy",
      platform: "darwin",
      target: resolveCliLauncherTarget({ ...base, electron: true }),
    });
    const node = renderCliLauncher({
      dataDir: "/Users/me/.sandy",
      platform: "darwin",
      target: resolveCliLauncherTarget({ ...base, electron: false }),
    });

    expect(electron).toContain("export ELECTRON_RUN_AS_NODE=1\n");
    expect(node).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("writes a Windows batch launcher that survives percent signs and spaces", () => {
    const launcher = renderCliLauncher({
      dataDir: "C:\\Users\\me\\.sandy",
      platform: "win32",
      target: {
        electron: true,
        entryPath: "C:\\Program Files (x86)\\sandy\\100%\\dist\\sandy.js",
        kind: "direct",
        runtimePath: "C:\\Program Files (x86)\\sandy\\sandy.exe",
      },
    });

    expect(launcher.split("\r\n")).toEqual([
      "@echo off",
      `rem ${CLI_LAUNCHER_MARKER}`,
      "setlocal EnableExtensions DisableDelayedExpansion",
      'if not defined SANDY_DATA_DIR set "SANDY_DATA_DIR=C:\\Users\\me\\.sandy"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      'if not exist "C:\\Program Files (x86)\\sandy\\sandy.exe" goto moved',
      'if exist "C:\\Program Files (x86)\\sandy\\100%%\\dist\\sandy.js" goto run',
      ":moved",
      "echo sandy has moved or been removed. Start sandy once to update this command. 1>&2",
      "exit /b 127",
      ":run",
      '"C:\\Program Files (x86)\\sandy\\sandy.exe" "C:\\Program Files (x86)\\sandy\\100%%\\dist\\sandy.js" %*',
      'set "sandy_exit=%ERRORLEVEL%"',
      "exit /b %sandy_exit%",
      "",
    ]);
  });

  it("leaves a launcher file that sandy did not write", async () => {
    const root = scratchDir();
    const launcherPath = join(root, "bin", "sandy");
    mkdirSync(dirname(launcherPath));
    writeFileSync(launcherPath, "#!/bin/sh\necho mine\n");

    await expect(
      writeCliLauncher({ content: "replacement", launcherPath }),
    ).resolves.toBe("foreign");
    expect(readFileSync(launcherPath, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("rewrites its own launcher when the install moves", async () => {
    const root = scratchDir();
    const launcherPath = join(root, "bin", "sandy");
    const first = `# ${CLI_LAUNCHER_MARKER}\nfirst\n`;
    const second = `# ${CLI_LAUNCHER_MARKER}\nsecond\n`;

    await expect(
      writeCliLauncher({ content: first, launcherPath }),
    ).resolves.toBe("written");
    await expect(
      writeCliLauncher({ content: first, launcherPath }),
    ).resolves.toBe("unchanged");
    await expect(
      writeCliLauncher({ content: second, launcherPath }),
    ).resolves.toBe("written");
    expect(readFileSync(launcherPath, "utf8")).toBe(second);
  });
});
