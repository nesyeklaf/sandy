// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginFileOpenerProps } from "@sandy-sdk/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import type { ViewOutput } from "./core/outputs.ts";
import type { rpcContract } from "./server.ts";

const app = await loadPluginApp(() => import("./app"));
const expectedDir = join(import.meta.dirname, "../../../docs/designs/holons/fixtures/shop/expected");
const views: Record<string, ViewOutput> = {
  "password-reset": JSON.parse(readFileSync(join(expectedDir, "view-password-reset.json"), "utf8")) as ViewOutput,
  account: JSON.parse(readFileSync(join(expectedDir, "view-account.json"), "utf8")) as ViewOutput,
};
const source = { kind: "workspace" as const, threadId: "thr_1", environmentId: "env_1", projectId: null };

afterEach(() => cleanup());

describe("Holon file opener", () => {
  it("registers for .holon files", () => {
    expect(app.fileOpeners.map((opener) => [opener.id, opener.extensions])).toEqual([["holon", ["holon"]]]);
  });

  it("shows the computed view and moves to the parent on click", async () => {
    const slot = renderSlot<PluginFileOpenerProps, typeof rpcContract>(
      app.fileOpeners[0]!,
      { path: "apps/account/password-reset.holon", source, Original: () => <div>Raw file</div> },
      { rpc: { view: (input) => ({ ok: true as const, root: "/work", view: views[input.id ?? "password-reset"]! }) } },
    );
    await waitFor(() => expect(slot.getByRole("heading", { level: 2 }).textContent).toContain("Password reset"));
    expect(slot.container.textContent).toContain("Expired on 2026-07-30");
    expect(slot.rpcCalls[0]).toEqual({
      method: "view",
      input: { source: { kind: "workspace", threadId: "thr_1", environmentId: "env_1" }, path: "apps/account/password-reset.holon" },
    });
    fireEvent.click(slot.getByRole("button", { name: /Account/ }));
    await waitFor(() => expect(slot.getByRole("heading", { level: 2 }).textContent).toContain("Account"));
    expect(slot.rpcCalls.at(-1)?.input).toMatchObject({ id: "account" });
  });

  it("falls back to the raw file with the error when the holon cannot be computed", async () => {
    const slot = renderSlot<PluginFileOpenerProps, typeof rpcContract>(
      app.fileOpeners[0]!,
      { path: "broken.holon", source, Original: () => <div>Raw file</div> },
      { rpc: { view: () => ({ ok: false as const, error: "broken.holon: not valid JSON" }) } },
    );
    await waitFor(() => expect(slot.getByRole("alert").textContent).toBe("broken.holon: not valid JSON"));
    expect(slot.getByText("Raw file")).toBeTruthy();
  });
});
