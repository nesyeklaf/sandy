import { setTimeout as delay } from "node:timers/promises";
import { createMigratedConnection } from "@sandy/db/testing";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { serverTiming } from "../../src/server-timing.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";

function metricDuration(header: string | null, name: string): number | null {
  const match = header?.match(new RegExp(`(?:^|, )${name};dur=([0-9.]+)`, "u"));
  return match?.[1] === undefined ? null : Number(match[1]);
}

function createDbApp() {
  const db = createMigratedConnection();
  db.$client.function("busy_wait", (milliseconds: unknown) => {
    const until = performance.now() + Number(milliseconds);
    while (performance.now() < until) {}
    return 1;
  });
  const app = new Hono();
  app.use("*", serverTiming());
  app.get("/api/v1/work/:workMs", async (context) => {
    const workMs = Number(context.req.param("workMs"));
    await delay(5);
    if (workMs > 0) {
      db.$client.prepare("select busy_wait(?)").get(workMs);
      await delay(5);
      db.$client.prepare("select busy_wait(?)").get(workMs);
    }
    return context.json({ ok: true });
  });
  app.get("/api/v1/transaction", (context) => {
    db.$client
      .transaction(() => {
        db.$client.prepare("select busy_wait(15)").get();
        db.$client.prepare("select busy_wait(15)").get();
      })
      .immediate();
    return context.json({ ok: true });
  });
  app.get("/api/v1/stream", () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        await delay(30);
        controller.enqueue(encoder.encode("data: second\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  app.get("/api/v1/immutable", () =>
    Response.redirect("http://localhost/api/v1/work/0", 302),
  );
  app.get("/assets/app.js", (context) => context.text("asset"));
  return app;
}

describe("Server-Timing", () => {
  it("reports total and the matched route pattern on a normal API route", async () => {
    const app = createDbApp();
    const response = await app.request("/api/v1/work/0");
    const header = response.headers.get("server-timing");
    expect(response.status).toBe(200);
    expect(metricDuration(header, "total")).toBeGreaterThanOrEqual(4);
    expect(metricDuration(header, "total")).toBeLessThan(500);
    expect(header).toContain('app;desc="/api/v1/work/:workMs"');
    expect(metricDuration(header, "db")).toBeNull();
  });

  it("attributes database time per request when requests run in parallel", async () => {
    const app = createDbApp();
    const [none, light, heavy] = await Promise.all(
      [0, 10, 40].map((workMs) => app.request(`/api/v1/work/${workMs}`)),
    );
    const noneDb = metricDuration(none!.headers.get("server-timing"), "db");
    const lightDb = metricDuration(light!.headers.get("server-timing"), "db");
    const heavyDb = metricDuration(heavy!.headers.get("server-timing"), "db");
    expect(noneDb).toBeNull();
    expect(lightDb).toBeGreaterThanOrEqual(19);
    expect(lightDb).toBeLessThan(40);
    expect(heavyDb).toBeGreaterThanOrEqual(79);
    expect(heavyDb).toBeLessThan(120);
  });

  it("counts a transaction once, not once per statement inside it", async () => {
    const app = createDbApp();
    const response = await app.request("/api/v1/transaction");
    const db = metricDuration(response.headers.get("server-timing"), "db");
    expect(db).toBeGreaterThanOrEqual(29);
    expect(db).toBeLessThan(50);
  });

  it("sets the header on streaming responses without disturbing the body", async () => {
    const app = createDbApp();
    const response = await app.request("/api/v1/stream");
    expect(response.headers.get("server-timing")).toContain("total;dur=");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
  });

  it("leaves websocket upgrades and non-API paths untouched", async () => {
    const app = createDbApp();
    const upgrade = await app.request("/api/v1/work/0", {
      headers: { upgrade: "websocket" },
    });
    expect(upgrade.headers.has("server-timing")).toBe(false);
    const asset = await app.request("/assets/app.js");
    expect(asset.headers.has("server-timing")).toBe(false);
  });

  it("keeps the header on responses with immutable headers", async () => {
    const app = createDbApp();
    const response = await app.request("/api/v1/immutable");
    expect(response.status).toBe(302);
    expect(response.headers.get("server-timing")).toContain("total;dur=");
  });

  it("names the API route even when the static shell catch-all is registered", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "sandy-server-timing-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html>");
    const harness = await createTestAppHarness();
    const serverApp = createApp(harness.deps, { staticDir });
    try {
      const api = await serverApp.app.request("/api/v1/system/config");
      expect(api.headers.get("server-timing")).toContain(
        'app;desc="/api/v1/system/config"',
      );
      const shell = await serverApp.app.request("/");
      expect(shell.headers.has("server-timing")).toBe(false);
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  it("survives compression and exposes timing to allowed cross-origin pages only", async () => {
    await withTestHarness(async (harness) => {
      const sameOrigin = await harness.app.request("/api/v1/system/config", {
        headers: { "accept-encoding": "br", origin: "http://localhost" },
      });
      expect(sameOrigin.headers.get("content-encoding")).toBe("br");
      expect(sameOrigin.headers.get("server-timing")).toContain("total;dur=");
      expect(sameOrigin.headers.get("server-timing")).toContain(
        'app;desc="/api/v1/system/config"',
      );
      expect(sameOrigin.headers.get("timing-allow-origin")).toBe(
        "http://localhost",
      );

      const noOrigin = await harness.app.request("/api/v1/system/config");
      expect(noOrigin.headers.has("server-timing")).toBe(true);
      expect(noOrigin.headers.has("timing-allow-origin")).toBe(false);

      const foreign = await harness.app.request("/api/v1/system/config", {
        headers: { origin: "https://evil.example" },
      });
      expect(foreign.headers.has("timing-allow-origin")).toBe(false);
    });
  });
});
