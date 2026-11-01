// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SandyDesktopServerChoice } from "@sandy/desktop-contract";
import {
  buildBridgeEventScript,
  buildBridgeInjectionScript,
  parsePageToShellMessage,
  type BridgeServer,
  type NativeShellHandshake,
} from "@sandy/mobile-bridge";
import { createSandyDesktopApi } from "../test/sandy-desktop-test-utils";
import { getNativeShell, resetNativeShellForTests } from "./native-shell";
import { getServerChoices, resetServerChoicesForTests } from "./server-choices";
import { useServerChoices } from "../hooks/useServerChoices";

const local: SandyDesktopServerChoice = {
  id: "builtin",
  name: "This Mac",
  origin: "http://127.0.0.1:38886",
  kind: "local",
  active: true,
};
const studio: SandyDesktopServerChoice = {
  id: "connect:studio",
  name: "Studio",
  origin: "https://studio.example.test",
  kind: "account",
  active: false,
};

function createDesktopApi() {
  return createSandyDesktopApi({
    platform: "macos",
    version: "test",
  });
}

function installDesktop() {
  const listeners = new Set<(choices: SandyDesktopServerChoice[]) => void>();
  const responses: ((choices: SandyDesktopServerChoice[]) => void)[] = [];
  const selectServer = vi.fn();
  window.sandyDesktop = {
    ...createDesktopApi(),
    listServerChoices: () =>
      new Promise((resolve) => {
        responses.push(resolve);
      }),
    onServerChoicesChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selectServer,
  };
  return {
    selectServer,
    requests: () => responses.length,
    async respond(index: number, choices: SandyDesktopServerChoice[]) {
      responses[index]?.(choices);
      await Promise.resolve();
    },
    change(next: SandyDesktopServerChoice[]) {
      for (const listener of listeners) listener(next);
    },
  };
}

const handshake: NativeShellHandshake = {
  bridgeVersion: 4,
  appVersion: "0.50.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: ["haptic", "badge", "share", "open-external", "safe-area"],
};

function installMobile(servers?: readonly BridgeServer[]) {
  const posted: string[] = [];
  Object.defineProperty(window, "ReactNativeWebView", {
    configurable: true,
    value: { postMessage: (raw: string) => posted.push(raw) },
  });
  // eslint-disable-next-line no-new-func
  new Function("window", buildBridgeInjectionScript(handshake, servers))(
    window,
  );
  return {
    posted,
    send(event: unknown) {
      // eslint-disable-next-line no-new-func
      new Function("window", buildBridgeEventScript(event))(window);
    },
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "sandyDesktop");
  Reflect.deleteProperty(window, "sandy");
  Reflect.deleteProperty(window, "ReactNativeWebView");
  resetNativeShellForTests();
  resetServerChoicesForTests();
});

describe("server choices", () => {
  it.each(["browser", "older desktop", "mobile app without a list"])(
    "offers no servers in a %s",
    (client) => {
      if (client === "older desktop") {
        window.sandyDesktop = {
          ...createDesktopApi(),
          getServerChoices: async () => [local],
          onServerChoicesChange: () => () => {},
          selectServer: () => {},
        };
      }
      if (client === "mobile app without a list") installMobile(undefined);
      expect(getServerChoices()).toBeNull();
      expect(renderHook(useServerChoices).result.current).toBeNull();
    },
  );

  it("loads desktop's list, follows changes, and switches by id", async () => {
    const desktop = installDesktop();
    const { result } = renderHook(useServerChoices);
    expect(result.current).toMatchObject({ status: "loading", servers: [] });
    await act(() => desktop.respond(0, [local, studio]));
    expect(result.current).toMatchObject({
      status: "ready",
      servers: [local, studio],
    });
    const switched = [
      { ...local, active: false },
      { ...studio, active: true },
    ];
    act(() => desktop.change(switched));
    expect(result.current?.servers).toEqual(switched);
    result.current?.switchTo("builtin");
    expect(desktop.selectServer).toHaveBeenCalledWith("builtin");
  });

  it("keeps a change desktop pushed while an older read was still in flight", async () => {
    const desktop = installDesktop();
    const { result } = renderHook(useServerChoices);
    const newer = [
      { ...local, active: false },
      { ...studio, active: true },
    ];
    act(() => desktop.change(newer));
    await act(() => desktop.respond(0, [local, studio]));
    expect(result.current?.servers).toEqual(newer);
  });

  it("re-reads desktop's list on each mount so account servers refresh", async () => {
    const desktop = installDesktop();
    const first = renderHook(useServerChoices);
    await act(() => desktop.respond(0, [local]));
    first.unmount();
    const second = renderHook(useServerChoices);
    expect(second.result.current).toMatchObject({
      status: "ready",
      servers: [local],
    });
    expect(desktop.requests()).toBe(2);
    await act(() => desktop.respond(1, [local, studio]));
    expect(second.result.current?.servers).toEqual([local, studio]);
  });

  it("shows the mobile app's list, follows its updates, and asks the app to switch", () => {
    const account: BridgeServer = { ...studio, id: "profile-1", active: true };
    const laptop: BridgeServer = {
      id: "profile-2",
      name: "Laptop",
      origin: "http://192.168.1.4:38886",
      kind: "custom",
      active: false,
    };
    const mobile = installMobile([account]);
    const { result } = renderHook(useServerChoices);
    expect(result.current).toMatchObject({
      status: "ready",
      servers: [account],
    });
    act(() => mobile.send({ type: "servers", servers: [account, laptop] }));
    expect(result.current?.servers).toEqual([account, laptop]);
    result.current?.switchTo("profile-2");
    const message = parsePageToShellMessage(mobile.posted.at(-1));
    expect(message).toEqual({
      ok: true,
      message: { type: "switch-server", id: "profile-2" },
    });
  });

  it("keeps the mobile bridge usable when the app's list is one this page cannot read", () => {
    installMobile([]);
    Reflect.set(Reflect.get(Reflect.get(window, "sandy"), "native"), "servers", [
      { ...studio, kind: "teleport" },
    ]);
    expect(getServerChoices()).toBeNull();
    expect(getNativeShell()?.handshake.platform).toBe("ios");
  });
});
