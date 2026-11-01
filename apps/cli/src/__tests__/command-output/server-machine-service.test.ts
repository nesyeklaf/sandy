import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readSandyAppRuntimeFile } from "@sandy/config/app-runtime-file";
import {
  readServerMovedFile,
  type ServerMovedFile,
  writeServerMovedFile,
} from "@sandy/server-archive";
import {
  collectLogPayloads,
  readlineMocks,
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerServerCommands } from "../../commands/server.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

const register: CommandRegistrar = (program) =>
  registerServerCommands(
    program.enablePositionalOptions(),
    () => "http://server",
  );

const FAKE_INSTALLER = `#!/bin/sh
printf '%s\\n' "$@" >"$FAKE_INSTALLER_LOG"
data_dir=$3
case "$(uname -s)" in
  Darwin)
    mkdir -p "$HOME/Library/LaunchAgents"
    printf '<plist><dict><key>EnvironmentVariables</key><dict><key>SANDY_DATA_DIR</key><string>%s</string></dict></dict></plist>\\n' "$data_dir" >"$HOME/Library/LaunchAgents/app.sandy.host-daemon.test.plist"
    ;;
  *)
    mkdir -p "$HOME/.config/systemd/user"
    printf '[Service]\\nEnvironment="SANDY_DATA_DIR=%s"\\n' "$data_dir" >"$HOME/.config/systemd/user/sandy-host-daemon-test.service"
    ;;
esac
exit "\${FAKE_INSTALLER_EXIT:-0}"
`;

interface Fixture {
  dataDir: string;
  homeDir: string;
  installerLog: string;
  root: string;
}

function movedLock(): ServerMovedFile {
  return {
    version: 1,
    moveId: "move-1",
    movedAt: 1_700_000_000_000,
    fromHostId: "host-laptop",
    toHostId: "host-desktop",
    toHostName: "desktop",
    serverUrl: "https://me.example.test",
    oldCopyEntries: ["sandy.db"],
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sandy-cli-machine-service-"));
  tempDirs.push(root);
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeServerMovedFile(dataDir, movedLock());
  await writeFile(
    join(dataDir, "auth.json"),
    JSON.stringify({ hostId: "host-laptop", hostKey: "secret" }),
  );
  await writeFile(
    join(dataDir, "config.json"),
    JSON.stringify({
      serverUrl: "https://me.example.test",
      serverHeaders: { "x-sandy-machine-access": "grant-secret" },
    }),
  );
  const installerPath = join(root, "install-machine.sh");
  await writeFile(installerPath, FAKE_INSTALLER);
  const installerLog = join(root, "installer.log");
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("SANDY_MACHINE_INSTALLER", installerPath);
  vi.stubEnv("FAKE_INSTALLER_LOG", installerLog);
  return { dataDir, homeDir, installerLog, root };
}

async function startRecordedSandy(fixture: Fixture): Promise<ChildProcess> {
  const entryPath = join(fixture.root, "sandy-app.js");
  await writeFile(entryPath, "setInterval(() => {}, 1000);\n");
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [entryPath], { stdio: "ignore" });
  children.push(child);
  await writeFile(
    join(fixture.dataDir, "sandy-app-runtime.json"),
    JSON.stringify({
      entryPath,
      pid: child.pid,
      serverUrl: "http://127.0.0.1:38886",
      startedAt,
      surface: "desktop",
      version: "0.43.4",
    }),
  );
  return child;
}

afterAll(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("sandy server install-machine-service", () => {
  setupCommandOutputTestEnvironment();

  it("stops the sandy running from the data directory and installs the service for it", async ({
    skip,
  }) => {
    skip(
      process.platform === "win32",
      "runs a POSIX shell installer for launchd/systemd",
    );
    const fixture = await createFixture();
    const sandy = await startRecordedSandy(fixture);
    const sandyExit = new Promise<NodeJS.Signals | null>((resolvePromise) => {
      sandy.once("exit", (_code, signal) => resolvePromise(signal));
    });

    await runCommand(
      [
        "server",
        "install-machine-service",
        "--data-dir",
        fixture.dataDir,
        "--yes",
        "--json",
      ],
      register,
    );

    await expect(sandyExit).resolves.toBe("SIGTERM");
    await expect(readSandyAppRuntimeFile(fixture.dataDir)).resolves.toBeNull();
    expect(
      (await readFile(fixture.installerLog, "utf8")).trim().split("\n"),
    ).toEqual(["--adopt", "--data-dir", fixture.dataDir]);
    const result = JSON.parse(collectLogPayloads(vi.mocked(console.log))[0]!);
    expect(result).toEqual({
      dataDir: fixture.dataDir,
      serverUrl: "https://me.example.test",
      serviceFile: expect.stringContaining(fixture.homeDir),
      toHostName: "desktop",
    });
    expect(collectLogPayloads(vi.mocked(console.error))).toEqual([
      `Stopped sandy on this computer (pid ${String(sandy.pid)}).`,
    ]);
    expect(await readServerMovedFile(fixture.dataDir)).toEqual(movedLock());
  });

  it("refuses a data directory that no server moved away from", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.dataDir, "server-moved.json"));

    await expect(
      runCommand(
        [
          "server",
          "install-machine-service",
          "--data-dir",
          fixture.dataDir,
          "--yes",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogPayloads(vi.mocked(console.error))).toEqual([
      `Error: ${fixture.dataDir} is not locked by a server move. This command keeps a computer connected as a machine after its sandy server moved to another machine.`,
    ]);
    await expect(readFile(fixture.installerLog, "utf8")).rejects.toThrow();
  });

  it("leaves sandy running when node on the PATH is too old for the service", async ({
    skip,
  }) => {
    skip(
      process.platform === "win32",
      "runs a POSIX shell installer for launchd/systemd",
    );
    const fixture = await createFixture();
    const sandy = await startRecordedSandy(fixture);
    const binDir = join(fixture.root, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "node"),
      "#!/bin/sh\nprintf '%s\\n' 20.18.1\n",
    );
    await chmod(join(binDir, "node"), 0o755);
    vi.stubEnv("PATH", [binDir, "/usr/bin", "/bin"].join(delimiter));

    await expect(
      runCommand(
        [
          "server",
          "install-machine-service",
          "--data-dir",
          fixture.dataDir,
          "--yes",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogPayloads(vi.mocked(console.error))).toEqual([
      "Error: The background service runs sandy with the node on your PATH, which is Node.js 20.18.1. Install Node.js 22.19 or newer, then run this command again.",
    ]);
    expect(sandy.exitCode).toBeNull();
    expect(sandy.signalCode).toBeNull();
    await expect(readFile(fixture.installerLog, "utf8")).rejects.toThrow();
  });

  it.runIf(process.platform === "win32")(
    "refuses on Windows before stopping sandy or running an installer",
    async () => {
      const fixture = await createFixture();

      await expect(
        runCommand(
          [
            "server",
            "install-machine-service",
            "--data-dir",
            fixture.dataDir,
            "--yes",
          ],
          register,
        ),
      ).rejects.toThrow("process.exit:1");

      expect(collectLogPayloads(vi.mocked(console.error))).toEqual([
        "Error: sandy cannot install the background machine service on Windows. It is available on macOS and Linux.",
      ]);
      await expect(readFile(fixture.installerLog, "utf8")).rejects.toThrow();
    },
  );

  it("reports an installer failure", async ({ skip }) => {
    skip(
      process.platform === "win32",
      "runs a POSIX shell installer for launchd/systemd",
    );
    const fixture = await createFixture();
    vi.stubEnv("FAKE_INSTALLER_EXIT", "1");
    readlineMocks.question.mockResolvedValue("y");

    await expect(
      runCommand(
        ["server", "install-machine-service", "--data-dir", fixture.dataDir],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(readlineMocks.question).toHaveBeenCalledWith(
      "Stop sandy on this computer and install a background service that keeps it connected to desktop? [y/N] ",
    );
    expect(collectLogPayloads(vi.mocked(console.error))).toEqual([
      "Error: The background service install failed; see the installer output above. Until it succeeds, this computer stays connected only while the sandy desktop app or npx sandy-app runs, so start one of them to reconnect it now.",
    ]);
  });
});

describe("sandy server unlock with a machine service", () => {
  setupCommandOutputTestEnvironment();

  it("refuses while a background service runs this computer as a machine", async ({
    skip,
  }) => {
    skip(
      process.platform === "win32",
      "runs a POSIX shell installer for launchd/systemd",
    );
    const fixture = await createFixture();
    await runCommand(
      [
        "server",
        "install-machine-service",
        "--data-dir",
        fixture.dataDir,
        "--yes",
        "--json",
      ],
      register,
    );
    const { serviceFile } = JSON.parse(
      collectLogPayloads(vi.mocked(console.log))[0]!,
    );
    vi.mocked(console.error).mockClear();

    await expect(
      runCommand(
        ["server", "unlock", "--data-dir", fixture.dataDir, "--yes", "--force"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogPayloads(vi.mocked(console.error))[0]).toContain(
      `Error: A background service (${serviceFile}) runs this computer as a machine from ${fixture.dataDir}.`,
    );
    expect(await readServerMovedFile(fixture.dataDir)).toEqual(movedLock());
  });
});
