import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { FORWARD_BODY_LIMIT_BYTES } from "./forward.ts";
import plugin, { EDITOR_ASSETS } from "./server.ts";

const FAKE = fileURLToPath(new URL("./test/fake-serve.mjs", import.meta.url));
const VENDOR = fileURLToPath(new URL("./vendor/holon-ui", import.meta.url));
const LOCAL_HOST = "host_local";

const disposers: (() => Promise<void> | void)[] = [];
const savedBin = process.env.HOLON_BIN;

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!();
  if (savedBin === undefined) delete process.env.HOLON_BIN;
  else process.env.HOLON_BIN = savedBin;
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holon-forward-"));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function loaded(environment: { path: string | null; hostId: string } | null) {
  process.env.HOLON_BIN = FAKE;
  const host = createFakePluginHost({
    pluginId: "holon",
    sdk: {
      threads: { get: async () => ({ id: "thr_1", environment: environment === null ? null : { id: "env_1", ...environment } }) },
      system: { config: async () => ({ primaryHostId: LOCAL_HOST }) },
    },
  });
  await plugin(host.sandy);
  disposers.push(() => host.harness.lifecycle.dispose());
  return host;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause as { issues?: { message: string }[] },
  );
  expect(error).not.toBeNull();
  return (error?.issues ?? []).map((issue) => issue.message).join("; ");
}

type Reply = { ok: true; status: number; text: string } | { ok: false; error: string };

describe("holon.forward", () => {
  it("serves /v0 of the thread's workspace and keeps the status and body of holon serve", async () => {
    const dir = workDir();
    const host = await loaded({ path: dir, hostId: LOCAL_HOST });
    const map = (await host.harness.callRpc("forward", { threadId: "thr_1", method: "GET", path: "/v0/map" })) as Reply;
    expect(map.ok && map.status).toBe(200);
    expect(map.ok && JSON.parse(map.text)).toMatchObject({ format: "holon-map/v0" });
    const policy = (await host.harness.callRpc("forward", { threadId: "thr_1", method: "PUT", path: "/v0/policy", body: '{"agentEdits":"direct"}' })) as Reply;
    expect(policy.ok && JSON.parse(policy.text)).toEqual({ method: "PUT", body: { agentEdits: "direct" }, contentType: "application/json", root: dir });
    const stale = (await host.harness.callRpc("forward", { threadId: "thr_1", method: "PUT", path: "/v0/file", body: '{"path":"a.md","content":"x","ifMatch":"stale"}' })) as Reply;
    expect(stale).toMatchObject({ ok: true, status: 409 });
    expect(stale.ok && JSON.parse(stale.text)).toMatchObject({ error: { code: "conflict" } });
  });

  it.each([
    ["a route the editor does not use", { method: "GET", path: "/v0/info" }, /not an editor route/],
    ["evidence writes", { method: "POST", path: "/v0/evidence", body: "{}" }, /not an editor route/],
    ["the workspace route", { method: "GET", path: "/v0/workspace" }, /not an editor route/],
    ["a dot-dot segment", { method: "GET", path: "/v0/holons/../info" }, /dot or slash segment/],
    ["an encoded dot-dot segment", { method: "GET", path: "/v0/holons/%2e%2e" }, /dot or slash segment/],
    ["an encoded slash", { method: "GET", path: "/v0/diagrams/a%2Fb" }, /dot or slash segment/],
    ["an unknown query", { method: "GET", path: "/v0/file", query: { path: "a", root: "/" } }, /takes no query root/],
    ["a wrong method", { method: "PUT", path: "/v0/map", body: "{}" }, /not an editor route/],
    ["a GET with a body", { method: "GET", path: "/v0/refs", body: "{}" }, /a GET has no body/],
    ["a path outside /v0", { method: "GET", path: "/p/x/v0/map" }, /\/v0\//],
  ])("refuses %s before it reaches holon serve", async (_name, request, reason) => {
    const dir = workDir();
    const host = await loaded({ path: dir, hostId: LOCAL_HOST });
    expect(await refusal(host.harness.callRpc("forward", { threadId: "thr_1", ...request }))).toMatch(reason);
  });

  it("refuses a body over the cap", async () => {
    const host = await loaded({ path: workDir(), hostId: LOCAL_HOST });
    const body = JSON.stringify({ path: "a.md", content: "x".repeat(FORWARD_BODY_LIMIT_BYTES), ifMatch: null });
    expect(await refusal(host.harness.callRpc("forward", { threadId: "thr_1", method: "PUT", path: "/v0/file", body }))).toContain("at most 8 MB");
  });

  it("answers an error reply for a thread without a local workspace", async () => {
    const remote = await loaded({ path: workDir(), hostId: "host_other" });
    expect(await remote.harness.callRpc("forward", { threadId: "thr_1", method: "GET", path: "/v0/map" })).toMatchObject({ ok: false, error: expect.stringContaining("another machine") });
    const none = await loaded(null);
    expect(await none.harness.callRpc("forward", { threadId: "thr_1", method: "GET", path: "/v0/map" })).toMatchObject({ ok: false, error: expect.stringContaining("no workspace") });
    const missing = await loaded({ path: join(workDir(), "gone"), hostId: LOCAL_HOST });
    expect(await missing.harness.callRpc("forward", { threadId: "thr_1", method: "GET", path: "/v0/map" })).toMatchObject({ ok: false, error: expect.stringContaining("not a directory") });
  });
});

describe("editor asset routes", () => {
  it("serves the vendored workers and wasm with their content types", async () => {
    const host = await loaded(null);
    for (const [file, contentType] of EDITOR_ASSETS) {
      const response = await host.harness.fetchHttp("GET", `/editor/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(VENDOR, file)))).toBe(true);
    }
  });
});
