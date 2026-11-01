import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_LAUNCHER_MARKER } from "@sandy/config/cli-command";
import {
  createCliCommandService,
  MACHINE_CLI_SHIM_MARKER,
  type CliCommandService,
  type WindowsUserPath,
} from "../../src/services/system/cli-command.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandy-cli-command-")));
  scratchDirs.push(dir);
  return dir;
}

const unusedWindowsUserPath: WindowsUserPath = {
  read: () => Promise.reject(new Error("not Windows")),
  write: () => Promise.reject(new Error("not Windows")),
};

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

interface UnixFixture {
  home: string;
  launcherPath: string;
  localBin: string;
  service: CliCommandService;
}

function createUnixFixture(
  args: { pathDirectories?: (home: string) => string[] } = {},
): UnixFixture {
  const home = join(scratchDir(), "home");
  const launcherPath = join(home, ".sandy", "bin", "sandy");
  const localBin = join(home, ".local", "bin");
  writeExecutable(launcherPath, `#!/bin/sh\n# ${CLI_LAUNCHER_MARKER}\n`);
  return {
    home,
    launcherPath,
    localBin,
    service: createCliCommandService({
      env: {
        PATH: (args.pathDirectories?.(home) ?? [localBin, "/usr/bin"]).join(
          ":",
        ),
      },
      homeDir: home,
      launcherPath,
      platform: "linux",
      windowsUserPath: unusedWindowsUserPath,
    }),
  };
}

const NOT_INSTALLED = {
  installedPath: null,
  onPath: false,
  shadowedBy: null,
  supported: true,
};

describe("sandy command on PATH", () => {
  posixIt(
    "links the launcher into a PATH folder and removes it again",
    async () => {
      const fixture = createUnixFixture();
      const link = join(fixture.localBin, "sandy");

      await expect(fixture.service.getStatus()).resolves.toEqual(NOT_INSTALLED);
      await expect(fixture.service.install()).resolves.toEqual({
        ...NOT_INSTALLED,
        installedPath: link,
        onPath: true,
      });
      expect(readlinkSync(link)).toBe(fixture.launcherPath);
      await expect(fixture.service.install()).resolves.toMatchObject({
        installedPath: link,
      });

      await expect(fixture.service.remove()).resolves.toEqual(NOT_INSTALLED);
      expect(existsSync(link)).toBe(false);
    },
  );

  posixIt("reports a link in a folder that is not on PATH yet", async () => {
    const fixture = createUnixFixture({ pathDirectories: () => ["/usr/bin"] });

    await expect(fixture.service.install()).resolves.toEqual({
      ...NOT_INSTALLED,
      installedPath: join(fixture.localBin, "sandy"),
      onPath: false,
    });
  });

  posixIt("refuses to install behind another sandy that runs first", async () => {
    const fixture = createUnixFixture({
      pathDirectories: (home) => [
        join(home, "tools"),
        join(home, ".local", "bin"),
      ],
    });
    const foreign = join(fixture.home, "tools", "sandy");
    writeExecutable(foreign, "#!/bin/sh\necho babashka\n");

    await expect(fixture.service.getStatus()).resolves.toEqual({
      ...NOT_INSTALLED,
      shadowedBy: { path: foreign, source: "other" },
    });
    await expect(fixture.service.install()).rejects.toMatchObject({
      body: {
        code: "cli_command_blocked",
        message: `Another sandy at ${foreign} comes first on your PATH. Remove it, or run sandy's command directly at ${fixture.launcherPath}.`,
      },
      status: 409,
    });
    expect(existsSync(join(fixture.localBin, "sandy"))).toBe(false);
    expect(readFileSync(foreign, "utf8")).toBe("#!/bin/sh\necho babashka\n");
  });

  posixIt("recognises a sandy that npm already put on PATH", async () => {
    const fixture = createUnixFixture({
      pathDirectories: (home) => [join(home, "npm", "bin")],
    });
    const packageRoot = join(fixture.home, "npm", "lib", "sandy-app");
    writeExecutable(join(packageRoot, "dist", "sandy.js"), "");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "sandy-app" }),
    );
    const npmBin = join(fixture.home, "npm", "bin", "sandy");
    mkdirSync(dirname(npmBin));
    symlinkSync(join(packageRoot, "dist", "sandy.js"), npmBin);

    await expect(fixture.service.getStatus()).resolves.toEqual({
      ...NOT_INSTALLED,
      shadowedBy: { path: npmBin, source: "npm" },
    });
    await expect(fixture.service.install()).rejects.toMatchObject({
      body: {
        message: `sandy is already on your PATH at ${npmBin}, installed by npm.`,
      },
    });
  });

  posixIt(
    "recognises the command a sandy machine install added and leaves it",
    async () => {
      const fixture = createUnixFixture();
      const machineShim = join(fixture.localBin, "sandy");
      writeExecutable(
        machineShim,
        `#!/bin/sh\nprintf '%s\\n' '${MACHINE_CLI_SHIM_MARKER}' >&2\nexit 1\n`,
      );

      await expect(fixture.service.getStatus()).resolves.toEqual({
        ...NOT_INSTALLED,
        shadowedBy: { path: machineShim, source: "machine" },
      });
      await expect(fixture.service.install()).rejects.toMatchObject({
        status: 409,
      });
      await fixture.service.remove();
      expect(lstatSync(machineShim).isFile()).toBe(true);
      expect(
        readFileSync(
          fileURLToPath(
            new URL("../../src/assets/install-machine.sh", import.meta.url),
          ),
          "utf8",
        ),
      ).toContain(MACHINE_CLI_SHIM_MARKER);
    },
  );

  posixIt("ignores the sandy that npx puts on PATH for the run", async () => {
    const fixture = createUnixFixture({
      pathDirectories: (home) => [
        join(home, ".npm", "_npx", "abc", "node_modules", ".bin"),
        join(home, ".local", "bin"),
      ],
    });
    writeExecutable(
      join(fixture.home, ".npm", "_npx", "abc", "node_modules", ".bin", "sandy"),
      "#!/bin/sh\n",
    );

    await expect(fixture.service.install()).resolves.toMatchObject({
      installedPath: join(fixture.localBin, "sandy"),
      onPath: true,
    });
  });

  posixIt(
    "repoints a link left by a sandy that used another data directory",
    async () => {
      const fixture = createUnixFixture();
      const otherLauncher = join(fixture.home, "other-data", "bin", "sandy");
      writeExecutable(otherLauncher, `#!/bin/sh\n# ${CLI_LAUNCHER_MARKER}\n`);
      const link = join(fixture.localBin, "sandy");
      mkdirSync(fixture.localBin, { recursive: true });
      symlinkSync(otherLauncher, link);

      await expect(fixture.service.install()).resolves.toMatchObject({
        installedPath: link,
      });
      expect(readlinkSync(link)).toBe(fixture.launcherPath);
    },
  );

  posixIt("asks for a restart when the launcher file is gone", async () => {
    const fixture = createUnixFixture();
    rmSync(fixture.launcherPath);

    await expect(fixture.service.install()).rejects.toMatchObject({
      body: {
        message: `The sandy command launcher at ${fixture.launcherPath} is missing. Restart sandy, then try again.`,
      },
    });
    expect(existsSync(join(fixture.localBin, "sandy"))).toBe(false);
  });

  it("is unavailable when sandy runs without a launcher, such as a source checkout", async () => {
    const service = createCliCommandService({
      env: {},
      homeDir: scratchDir(),
      launcherPath: null,
      platform: process.platform,
      windowsUserPath: unusedWindowsUserPath,
    });

    await expect(service.getStatus()).resolves.toEqual({
      ...NOT_INSTALLED,
      supported: false,
    });
    await expect(service.install()).rejects.toMatchObject({
      body: { code: "cli_command_unsupported" },
      status: 409,
    });
  });
});

describe("sandy command on the Windows PATH", () => {
  function createWindowsFixture(initialPath: string | Error): {
    service: CliCommandService;
    userPath: () => string;
    writes: () => number;
  } {
    const launcherPath = join(scratchDir(), "sandy.cmd");
    writeFileSync(launcherPath, `@echo off\r\nrem ${CLI_LAUNCHER_MARKER}\r\n`);
    let value = initialPath instanceof Error ? "" : initialPath;
    let writes = 0;
    return {
      service: createCliCommandService({
        env: {},
        homeDir: dirname(launcherPath),
        launcherPath,
        platform: "win32",
        windowsUserPath: {
          read: () =>
            initialPath instanceof Error
              ? Promise.reject(initialPath)
              : Promise.resolve(value),
          write: (next) => {
            value = next;
            writes += 1;
            return Promise.resolve();
          },
        },
      }),
      userPath: () => value,
      writes: () => writes,
    };
  }

  it("appends the launcher folder once and takes out only that entry on remove", async () => {
    const fixture = createWindowsFixture(
      "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools",
    );

    await expect(fixture.service.install()).resolves.toMatchObject({
      onPath: true,
      supported: true,
    });
    expect(fixture.userPath()).toMatch(
      /^%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools;.+$/u,
    );
    await fixture.service.install();
    expect(fixture.writes()).toBe(1);

    await expect(fixture.service.remove()).resolves.toMatchObject({
      installedPath: null,
    });
    expect(fixture.userPath()).toBe(
      "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools",
    );
  });

  it("never writes PATH when reading it fails", async () => {
    const fixture = createWindowsFixture(new Error("registry unavailable"));

    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      installedPath: null,
      supported: true,
    });
    await expect(fixture.service.install()).rejects.toMatchObject({
      body: { message: "Could not read your PATH, so it was left unchanged." },
    });
    expect(fixture.writes()).toBe(0);
  });
});
