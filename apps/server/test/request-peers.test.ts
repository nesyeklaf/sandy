import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRequestPeerRecorder } from "../src/services/request-peers.js";
import type { SandyPluginApi } from "../src/services/plugins/plugin-api.js";
import { startTestServer, type RunningTestServer } from "./helpers/test-app.js";

const PLUGIN_ID = "request-peers-fixture";
const SOCKET_PATH = `/api/v1/plugins/${PLUGIN_ID}/http/socket`;
const FIXTURE_SOURCE = `
  export default function plugin(sandy: any) {
    sandy.http.experimental_websocket("/socket", () => ({
      onOpen(socket: any) {
        socket.send("open");
      },
    }));
  }
`;

function rawRequest(
  baseUrl: string,
  args: { method: string; path: string; headers?: Record<string, string> },
): Promise<number> {
  const url = new URL(args.path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method: args.method,
        path: url.pathname,
        headers: args.headers ?? {},
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("request peer recorder", () => {
  let server: RunningTestServer;
  let workDir: string;

  function api(): SandyPluginApi {
    const handle = server.pluginService.getApi(PLUGIN_ID);
    if (!handle) throw new Error("fixture plugin is not running");
    return handle;
  }

  function peersAfter(after: number) {
    return api().server.internal_DO_NOT_USE_requestPeers({ after }).peers;
  }

  function latestSeq(): number {
    return api().server.internal_DO_NOT_USE_requestPeers().latestSeq;
  }

  beforeEach(async () => {
    server = await startTestServer();
    workDir = await mkdtemp(join(tmpdir(), "sandy-request-peers-"));
    const rootDir = join(workDir, `sandy-plugin-${PLUGIN_ID}`);
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: `sandy-plugin-${PLUGIN_ID}`,
        version: "0.1.0",
        sandy: {
          name: "Request peers fixture",
          description: "Request peers fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), FIXTURE_SOURCE);
    await server.pluginService.installPath(rootDir);
  });

  afterEach(async () => {
    await server.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("records one HTTP request with its socket peer, method and status", async () => {
    const before = latestSeq();
    expect(
      await rawRequest(server.baseUrl, { method: "GET", path: "/health" }),
    ).toBe(200);
    const peers = peersAfter(before);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      seq: before + 1,
      address: "127.0.0.1",
      localPort: Number(new URL(server.baseUrl).port),
      method: "GET",
      status: 200,
      websocket: false,
    });
    expect(peers[0]?.port).toBeGreaterThan(0);
    expect(Object.keys(peers[0] ?? {}).sort()).toEqual([
      "address",
      "at",
      "localPort",
      "method",
      "port",
      "seq",
      "status",
      "websocket",
    ]);
  });

  it("records one WebSocket upgrade", async () => {
    const before = latestSeq();
    const socket = new WebSocket(
      `${server.baseUrl.replace("http", "ws")}${SOCKET_PATH}`,
    );
    const first = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(String(data)));
      socket.once("error", reject);
    });
    socket.close();
    expect(first).toBe("open");
    const peers = peersAfter(before);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      address: "127.0.0.1",
      method: "GET",
      websocket: true,
    });
  });

  it("records a request the host check rejects", async () => {
    const before = latestSeq();
    const status = await rawRequest(server.baseUrl, {
      method: "GET",
      path: "/health",
      headers: { host: "probe.invalid" },
    });
    expect(status).toBe(403);
    const peers = peersAfter(before);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ address: "127.0.0.1", status: 403 });
  });

  it("ignores forwarding and identity headers for the recorded peer", async () => {
    const before = latestSeq();
    await rawRequest(server.baseUrl, {
      method: "GET",
      path: "/health",
      headers: {
        "x-forwarded-for": "203.0.113.7",
        forwarded: "for=203.0.113.7",
        "x-real-ip": "203.0.113.7",
        "tailscale-user-login": "someone@example.com",
        "tailscale-user-name": "Someone",
      },
    });
    const peers = peersAfter(before);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      address: "127.0.0.1",
      websocket: false,
    });
    expect(JSON.stringify(peers[0])).not.toContain("203.0.113.7");
    expect(JSON.stringify(peers[0])).not.toContain("someone");
  });
});

describe("request peer recorder bound", () => {
  it("keeps only its capacity under a flood and reports what it dropped", async () => {
    const recorder = createRequestPeerRecorder({ capacity: 16 });
    const app = new Hono();
    app.use("*", recorder.middleware);
    app.get("/", (context) => context.text("ok"));
    for (let index = 0; index < 1000; index += 1) await app.request("/");
    const snapshot = recorder.snapshot();
    expect(snapshot.latestSeq).toBe(1000);
    expect(snapshot.oldestSeq).toBe(985);
    expect(snapshot.peers).toHaveLength(16);
    expect(snapshot.peers.map((peer) => peer.seq)).toEqual(
      Array.from({ length: 16 }, (_, index) => 985 + index),
    );
    expect(snapshot.peers[0]).toMatchObject({ address: null, status: 200 });
    expect(recorder.snapshot(998).peers.map((peer) => peer.seq)).toEqual([
      999, 1000,
    ]);
  });

  it("records a request whose handler throws", async () => {
    const recorder = createRequestPeerRecorder({ capacity: 4 });
    const app = new Hono();
    app.use("*", recorder.middleware);
    app.get("/", () => {
      throw new Error("boom");
    });
    expect((await app.request("/")).status).toBe(500);
    expect(recorder.snapshot().peers).toHaveLength(1);
  });
});
