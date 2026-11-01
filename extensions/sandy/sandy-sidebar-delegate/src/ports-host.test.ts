import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@sandy-sdk/plugin-sdk/testing/host";

const mocks = vi.hoisted(() => ({ run: vi.fn(), platform: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.run }) };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: mocks.platform,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  realpath: async (path: string) => path,
}));
import entry from "./ports-host";

const roots = [{ environmentId: "env_a", path: "/workspace/app" }];
const sockets = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node 123 u 1u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)
node 456 u 1u IPv4 0x2 0t0 TCP 127.0.0.1:4000 (LISTEN)
`;
let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof entry.contract, {}>>;

beforeEach(() => {
  mocks.run.mockReset();
  mocks.platform.mockReturnValue("darwin");
  harness = experimental_createHostEntryHarness(entry);
});
afterEach(async () => {
  await harness.experimental_dispose();
});

function commands(docker: () => string = () => "") {
  mocks.run.mockImplementation(async (command: string, args: string[]) => {
    if (command === "lsof")
      return { stdout: args.includes("-d") ? "p123\nfcwd\nn/workspace/app\np456\nfcwd\nn/workspace/app\n" : sockets };
    if (command === "ps")
      return {
        stdout:
          args[0] === "eww"
            ? "node app.js SANDY_THREAD_ID=thr_owner PATH=/bin"
            : args.includes("lstart=")
              ? "Sat Oct  3 12:29:38 2026\n"
              : "123 node app.js\n456 node /opt/sandy-app/server/dist/index.js",
      };
    if (command === "docker") return { stdout: docker() };
    throw new Error(`Unexpected command ${command}`);
  });
}

describe("host port scan", () => {
  it("enriches process listeners with Docker metadata without losing ownership or bind address", async () => {
    commands(() => "abc\tapp-web-1\t0.0.0.0:3000->3000/tcp, 0.0.0.0:8080->8080/tcp\t/workspace/app\tweb");
    const result = await harness.experimental_call("scan", { roots });
    expect(result.ports).toEqual([
      {
        environmentId: "env_a",
        port: 3000,
        address: "127.0.0.1",
        pid: 123,
        processName: "node",
        source: "process",
        ownerThreadId: "thr_owner",
        processStartedAt: "Sat Oct  3 12:29:38 2026",
        container: "app-web-1",
        service: "web",
      },
      {
        environmentId: "env_a",
        port: 8080,
        address: "0.0.0.0",
        source: "docker",
        container: "app-web-1",
        service: "web",
      },
    ]);
  });

  it("keeps user listeners and excludes SANDY listeners when Docker is unavailable", async () => {
    commands(() => {
      throw new Error("ENOENT");
    });
    const result = await harness.experimental_call("scan", {
      roots: [...roots, { environmentId: "env_b", path: roots[0].path }],
    });
    expect(
      result.ports.map(({ environmentId, port, ownerThreadId }) => ({ environmentId, port, ownerThreadId })),
    ).toEqual([
      { environmentId: "env_a", port: 3000, ownerThreadId: "thr_owner" },
      { environmentId: "env_b", port: 3000, ownerThreadId: "thr_owner" },
    ]);
  });

  it("propagates cancellation instead of returning a partial scan", async () => {
    const controller = new AbortController();
    commands(() => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(harness.experimental_call("scan", { roots }, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("host pull request lookup", () => {
  it("reads each PR with gh and skips the ones it cannot see", async () => {
    mocks.run.mockImplementation(async (command: string, args: string[]) => {
      if (command !== "gh") throw new Error(`Unexpected command ${command}`);
      if (args[2]!.endsWith("/2")) throw new Error("Could not resolve to a PullRequest");
      return {
        stdout: JSON.stringify({
          number: 1,
          title: "Fix",
          state: "OPEN",
          isDraft: true,
          url: "https://github.com/new/r/pull/1",
        }),
      };
    });
    const result = await harness.experimental_call("pullRequests", {
      urls: ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"],
    });
    expect(result.pullRequests).toEqual([
      { url: "https://github.com/o/r/pull/1", number: 1, title: "Fix", state: "draft" },
    ]);
  });
});
