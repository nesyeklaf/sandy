// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginFileOpenerProps, PluginRpcContract } from "@sandy-sdk/plugin-sdk/app";
import { loadPluginApp, renderSlot as renderPluginSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import type { MapHolon, MapOutput, ViewOutput } from "./core/outputs.ts";
import type { rpcContract } from "./server.ts";

const app = await loadPluginApp(() => import("./app"));
const expectedDir = join(import.meta.dirname, "../../../docs/designs/holons/fixtures/shop/expected");
const views: Record<string, ViewOutput> = {
  "password-reset": JSON.parse(readFileSync(join(expectedDir, "view-password-reset.json"), "utf8")) as ViewOutput,
  account: JSON.parse(readFileSync(join(expectedDir, "view-account.json"), "utf8")) as ViewOutput,
};
function holon(id: string, title: string, parent: string | null, file: string, childCount: number): MapHolon {
  return {
    id,
    kind: "component",
    title,
    status: "active",
    parent,
    file,
    light: "soft",
    sides: { I: "hard", It: "soft", We: "open", They: "claimed" },
    drift: [],
    driftBelow: 0,
    childCount,
    carriedBy: [],
  };
}

const map: MapOutput = {
  format: "holon-map/v0",
  holons: [
    holon("shop", "Shop", null, "shop.holon", 1),
    holon("account", "Account", "shop", "apps/account.holon", 1),
    holon("password-reset", "Password reset", "account", "apps/account/password-reset.holon", 0),
  ],
  seams: [],
  warnings: [],
  computedAt: "2026-08-01T00:00:00Z",
  commit: "0123456789abcdef",
};
const mapReply = () => ({ ok: true as const, root: "/work", map });
const source = { kind: "workspace" as const, threadId: "thr_1", environmentId: "env_1", projectId: null };

const mounted: Array<() => void> = [];

function renderSlot<Props extends object, Contract extends PluginRpcContract>(...args: Parameters<typeof renderPluginSlot<Props, Contract>>) {
  const slot = renderPluginSlot<Props, Contract>(...args);
  mounted.push(() => slot.unmount());
  return slot;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  cleanup();
});

describe("Holon file opener", () => {
  it("registers for .holon files", () => {
    expect(app.fileOpeners.map((opener) => [opener.id, opener.extensions])).toEqual([["holon", ["holon"]]]);
  });

  it("shows the computed view and moves to the parent on click", async () => {
    const slot = renderSlot<PluginFileOpenerProps, typeof rpcContract>(
      app.fileOpeners[0]!,
      { path: "apps/account/password-reset.holon", source, Original: () => <div>Raw file</div> },
      { rpc: { view: (input) => ({ ok: true as const, root: "/work", view: views[input.id ?? "password-reset"]! }), map: mapReply } },
    );
    await waitFor(() => expect(slot.getByRole("heading", { level: 2 }).textContent).toContain("Password reset"));
    await waitFor(() => expect(slot.getByRole("button", { name: /^Password reset, component/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(slot.getByRole("button", { name: /^Account, component/ })).toBeTruthy();
    expect(slot.rpcCalls.find((call) => call.method === "map")?.input).toEqual({
      source: { kind: "workspace", threadId: "thr_1", environmentId: "env_1" },
      path: "apps/account/password-reset.holon",
    });
    expect(slot.container.textContent).toContain("Expired on 2026-07-30");
    expect(slot.rpcCalls.find((call) => call.method === "view")).toEqual({
      method: "view",
      input: { source: { kind: "workspace", threadId: "thr_1", environmentId: "env_1" }, path: "apps/account/password-reset.holon" },
    });
    fireEvent.click(slot.getAllByRole("button", { name: /Account/ }).find((button) => button.closest("svg") === null)!);
    await waitFor(() => expect(slot.getByRole("heading", { level: 2 }).textContent).toContain("Account"));
    expect(slot.rpcCalls.filter((call) => call.method === "view").at(-1)?.input).toMatchObject({ id: "account" });
    await waitFor(() => expect(slot.getByRole("button", { name: /^Account, component/ }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("selects a holon from the map and loads its card", async () => {
    const slot = renderSlot<PluginFileOpenerProps, typeof rpcContract>(
      app.fileOpeners[0]!,
      { path: "apps/account/password-reset.holon", source, Original: () => <div>Raw file</div> },
      { rpc: { view: (input) => ({ ok: true as const, root: "/work", view: views[input.id ?? "password-reset"]! }), map: mapReply } },
    );
    const account = await slot.findByRole("button", { name: /^Account, component/ });
    fireEvent.click(account);
    await waitFor(() => expect(slot.getByRole("heading", { level: 2 }).textContent).toContain("Account"));
  });

  it("keeps the card when the map cannot be computed", async () => {
    const slot = renderSlot<PluginFileOpenerProps, typeof rpcContract>(
      app.fileOpeners[0]!,
      { path: "apps/account/password-reset.holon", source, Original: () => <div>Raw file</div> },
      {
        rpc: {
          view: (input) => ({ ok: true as const, root: "/work", view: views[input.id ?? "password-reset"]! }),
          map: () => ({ ok: false as const, error: "map failed" }),
        },
      },
    );
    await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("map failed"));
    expect(slot.getByRole("heading", { level: 2 }).textContent).toContain("Password reset");
  });

  it("falls back to the raw file with the error when the holon cannot be computed", async () => {
    const slot = renderSlot<PluginFileOpenerProps, typeof rpcContract>(
      app.fileOpeners[0]!,
      { path: "broken.holon", source, Original: () => <div>Raw file</div> },
      { rpc: { view: () => ({ ok: false as const, error: "broken.holon: not valid JSON" }), map: mapReply } },
    );
    await waitFor(() => expect(slot.getByRole("alert").textContent).toBe("broken.holon: not valid JSON"));
    expect(slot.getByText("Raw file")).toBeTruthy();
  });
});
