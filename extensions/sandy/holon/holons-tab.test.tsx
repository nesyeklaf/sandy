// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ComponentType } from "react";
import type { ExperimentalThreadTabProps } from "@sandy-sdk/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import type { ForwardInput, ForwardResult } from "./forward.ts";
import type { rpcContract } from "./server.ts";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const app = await loadPluginApp(() => import("./app"));
const tab = () => app.tabs.find((registration) => registration.id === "holons")!;
const threadTab = () => ({ component: tab().component as ComponentType<ExperimentalThreadTabProps> });
const unmounts: Array<() => void> = [];

afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
  cleanup();
});

const emptyMap = { format: "holon-map/v0", holons: [], seams: [], warnings: [], computedAt: "2026-08-01T00:00:00Z", commit: "none" };

function serve(replies: (input: ForwardInput) => ForwardResult) {
  return (input: ForwardInput): ForwardResult => replies(input);
}

function render(props: ExperimentalThreadTabProps, forward: (input: ForwardInput) => ForwardResult) {
  const slot = renderSlot<ExperimentalThreadTabProps, typeof rpcContract>(threadTab(), props, {
    rpc: { forward },
  });
  unmounts.push(() => slot.unmount());
  return slot;
}

describe("Holons thread tab", () => {
  it("registers a fixed, flush thread tab", () => {
    expect(tab()).toMatchObject({ id: "holons", title: "Holons", availability: "fixed", layout: "flush", context: { kind: "thread" } });
  });

  it("says so for a thread without a workspace and sends nothing", () => {
    const slot = render({ threadId: "thr_1", environment: null } as ExperimentalThreadTabProps, () => {
      throw new Error("no call expected");
    });
    expect(slot.getByRole("status").textContent).toContain("no workspace");
    expect(slot.rpcCalls).toEqual([]);
  });

  it("shows the failure with Retry, then the editor on the thread's /v0", async () => {
    let healthy = false;
    const slot = render(
      { threadId: "thr_1", environment: { id: "env_1" } } as ExperimentalThreadTabProps,
      serve((input) => {
        if (input.path === "/v0/health") return healthy ? { ok: true, status: 200, text: '{"ok":true}' } : { ok: false, error: "holon is not installed" };
        if (input.path === "/v0/map") return { ok: true, status: 200, text: JSON.stringify(emptyMap) };
        return { ok: true, status: 404, text: JSON.stringify({ ok: false, error: { code: "not_found", message: "no route" } }) };
      }),
    );
    await waitFor(() => expect(slot.getByRole("status").textContent).toContain("holon is not installed"));
    healthy = true;
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(slot.container.querySelector(".holon-ui")).not.toBeNull());
    await waitFor(() => expect(slot.rpcCalls.some((call) => (call.input as ForwardInput).path === "/v0/map")).toBe(true));
    const paths = slot.rpcCalls.map((call) => (call.input as ForwardInput).path);
    expect(paths).not.toContain("/v0/workspace");
    expect(slot.rpcCalls.every((call) => (call.input as ForwardInput).threadId === "thr_1")).toBe(true);
    expect(slot.container.querySelector(".holon-ui")?.getAttribute("data-theme")).toBe("light");
  });
});
