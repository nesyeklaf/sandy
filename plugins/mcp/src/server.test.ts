import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

async function load() {
  const host = createFakePluginHost({
    pluginId: "sandy--mcp",
    loopbackBaseUrl: "http://127.0.0.1:4000",
  });
  await plugin(host.sandy);
  return host;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
});

function mcpRequest(headers: Record<string, string>): RequestInit {
  return {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: INITIALIZE,
  };
}

describe("MCP route", () => {
  it("answers a caller without an origin", async () => {
    const host = await load();
    const response = await host.harness.fetchHttp(
      "POST",
      "/mcp",
      mcpRequest({}),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"name":"sandy"');
  });

  it("refuses web pages before any MCP handling, with or without old gate headers", async () => {
    const host = await load();
    const refused: Record<string, string>[] = [
      { origin: "https://evil.example" },
      {
        origin: "https://evil.example",
        "x-sandy-gate-auth": "oauth",
        "x-sandy-gate-oauth-scope": "sandy",
      },
    ];
    for (const headers of refused) {
      const response = await host.harness.fetchHttp(
        "POST",
        "/mcp",
        mcpRequest(headers),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden" });
    }
  });
});

describe("sandy mcp", () => {
  it("prints the loopback MCP address", async () => {
    const host = await load();
    const result = await host.harness.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      localUrl: "http://127.0.0.1:4000/api/v1/plugins/sandy--mcp/http/mcp",
    });
  });

  it("no longer offers the account-backed client commands", async () => {
    const host = await load();
    for (const command of ["clients", "revoke"]) {
      expect((await host.harness.runCli([command])).exitCode).not.toBe(0);
    }
  });
});
