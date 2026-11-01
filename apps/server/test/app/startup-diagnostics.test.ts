import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "@sandy/config/server";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  closeHttpListener,
  startHttpListeners,
} from "../../src/start-server.js";

const testDir = dirname(fileURLToPath(import.meta.url));

async function readServerEntrypoint(): Promise<string> {
  return readFile(resolve(testDir, "../../src/index.ts"), "utf8");
}

async function readServerPackageJson(): Promise<string> {
  return readFile(resolve(testDir, "../../package.json"), "utf8");
}

describe("server startup diagnostics", () => {
  it("installs safe diagnostics before loading the startup module", async () => {
    const source = await readServerEntrypoint();
    const installCallIndex = source.indexOf("installSafeProcessDiagnostics({");
    const startupImportIndex = source.indexOf('import("./start-server.js")');

    expect(installCallIndex).toBeGreaterThanOrEqual(0);
    expect(startupImportIndex).toBeGreaterThan(installCallIndex);
    expect(source).not.toContain('from "./db.js"');
    expect(source).not.toContain('from "./server.js"');
    expect(source).not.toContain("process.report");
  });

  it("keeps the startup bundle external to the production bootstrap", async () => {
    const packageJson = await readServerPackageJson();

    expect(packageJson).toContain("--external ./start-server.js");
    expect(packageJson).toContain("src/start-server.ts dist/start-server.js");
  });

  async function closeAll(
    servers: ReturnType<typeof startHttpListeners>,
  ): Promise<void> {
    await Promise.all(servers.map(closeHttpListener));
  }

  const logger = { warn: vi.fn() };

  async function listeningAddresses(
    servers: ReturnType<typeof startHttpListeners>,
  ): Promise<unknown[]> {
    const addresses: unknown[] = [];
    for (const server of servers) {
      if (!server.listening) {
        await once(server, "listening");
      }
      addresses.push(server.address());
    }
    return addresses;
  }

  it("binds only IPv4 loopback by default", async () => {
    const serverConfig = loadServerConfig({
      env: {
        SANDY_DATA_DIR: "/tmp/sandy-server-listener-test",
        SANDY_HOST_DAEMON_PORT: "49162",
        SANDY_SERVER_PORT: "49161",
        NODE_ENV: "development",
      },
    });
    const servers = startHttpListeners({
      fetch: () => new Response("ok"),
      serverConfig: { ...serverConfig, SANDY_SERVER_PORT: 0 },
      logger,
    });

    try {
      expect(await listeningAddresses(servers)).toEqual([
        expect.objectContaining({ address: "127.0.0.1", family: "IPv4" }),
      ]);
    } finally {
      await closeAll(servers);
    }
  });

  it.runIf(process.platform === "linux")(
    "keeps loopback and adds one listener per configured address",
    async () => {
      const servers = startHttpListeners({
        fetch: () => new Response("ok"),
        serverConfig: { SANDY_SERVER_BIND_HOST: ["127.0.0.2"], SANDY_SERVER_PORT: 0 },
        logger,
      });

      try {
        expect(await listeningAddresses(servers)).toEqual([
          expect.objectContaining({ address: "127.0.0.1", family: "IPv4" }),
          expect.objectContaining({ address: "127.0.0.2", family: "IPv4" }),
        ]);
      } finally {
        await closeAll(servers);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps loopback serving and retries when a listed address is not up yet",
    async () => {
      const warn = vi.fn();
      const servers = startHttpListeners({
        fetch: () => new Response("ok"),
        serverConfig: {
          SANDY_SERVER_BIND_HOST: ["100.64.0.99"],
          SANDY_SERVER_PORT: 0,
        },
        logger: { warn },
        extraListenerRetryMs: 20,
      });

      try {
        const [loopback] = servers;
        if (!loopback.listening) await once(loopback, "listening");
        const address = loopback.address();
        if (address === null || typeof address === "string")
          throw new Error("loopback has no port");
        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        expect(await response.text()).toBe("ok");
        await vi.waitFor(() =>
          expect(warn.mock.calls.length).toBeGreaterThan(1),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ hostname: "100.64.0.99" }),
          expect.stringContaining("loopback keeps serving"),
        );
        expect(servers[1]?.listening).toBe(false);
      } finally {
        await closeAll(servers);
      }
    },
  );
});
