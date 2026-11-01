// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type * as PluginSdkApp from "@sandy-sdk/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadActions, type ThreadActions } from "./Fence";

// SANDY's runtime is replaced by one thread: a workspace, a thread storage and a host.
const STORAGE = "/Users/me/.sandy/thread-storage/thr_1";
const WORKSPACE = "/Users/me/Projects/site";
const openFilePreview = vi.fn((_options: unknown) => true);
const sdk = {
  threads: {
    get: vi.fn(async () => ({ environmentId: "env_1", environment: { path: WORKSPACE, hostId: "host_1" } })),
    storageLocation: vi.fn(async () => ({ storageRootPath: STORAGE, hostId: "host_1" })),
  },
};
vi.mock("@sandy-sdk/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => [],
  useSdk: () => sdk,
  useSandyNavigate: () => ({ experimental_openFilePreview: openFilePreview }),
}));

let actions: ThreadActions | null = null;
function Probe() {
  actions = useThreadActions();
  return null;
}

let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  openFilePreview.mockClear();
  container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  actions = null;
  vi.unstubAllGlobals();
});

async function opened(path: string): Promise<{ opened: boolean; target: unknown }> {
  const result = await actions!.openFile("thr_1", path);
  return { opened: result, target: (openFilePreview.mock.calls.at(-1)?.[0] as { target: unknown } | undefined)?.target ?? null };
}

describe("opening a file a spec names", () => {
  it("opens an absolute thread-storage path in the thread's storage, the way Image(path) already reads it", async () => {
    expect(await opened(`${STORAGE}/shots/hero.png`)).toEqual({
      opened: true,
      target: { kind: "thread-storage", threadId: "thr_1", path: "shots/hero.png" },
    });
  });

  it("opens $SANDY_THREAD_STORAGE/ paths in the thread's storage", async () => {
    expect(await opened("$SANDY_THREAD_STORAGE/hero.png")).toEqual({
      opened: true,
      target: { kind: "thread-storage", threadId: "thr_1", path: "hero.png" },
    });
  });

  it("opens an absolute workspace path as the workspace-relative file", async () => {
    expect(await opened(`${WORKSPACE}/src/app.ts`)).toEqual({
      opened: true,
      target: { kind: "workspace", environmentId: "env_1", path: "src/app.ts" },
    });
  });

  it("opens a relative path in the workspace", async () => {
    expect(await opened("src/app.ts")).toEqual({
      opened: true,
      target: { kind: "workspace", environmentId: "env_1", path: "src/app.ts" },
    });
  });

  it("opens a /tmp file on the thread's host, as Image(path) reads it", async () => {
    expect(await opened("/tmp/shot.png")).toEqual({
      opened: true,
      target: { kind: "host", hostId: "host_1", path: "/tmp/shot.png" },
    });
  });

  it("opens nothing for an absolute path outside the workspace, the storage and /tmp, or one that climbs out of the storage", async () => {
    expect(await opened("/etc/hosts")).toEqual({ opened: false, target: null });
    expect(await opened(`${STORAGE}/../thr_2/secret.png`)).toEqual({ opened: false, target: null });
    expect(openFilePreview).not.toHaveBeenCalled();
  });
});
