import { describe, expect, it } from "vitest";
import {
  buildDesktopServerChoices,
  customServerId,
} from "../src/server-list.js";
import {
  BUILTIN_SERVER_NAME,
  createServerTargetStore,
} from "../src/server-target.js";

const LOCAL_URL = "http://127.0.0.1:38886";

function createStore() {
  return createServerTargetStore({
    storagePath: "/test/server-target.json",
    fs: {
      mkdir: async () => undefined,
      readFile: async () => "",
      writeFile: async () => undefined,
    },
  });
}

describe("buildDesktopServerChoices", () => {
  it("lists the built-in server and each saved server by name or hostname", async () => {
    const store = createStore();
    await store.setCustomServerUrl("https://work.example.test", {
      name: "Devbox",
    });
    await store.setCustomServerUrl("https://sandy.example.com/team", {
      name: null,
    });

    expect(buildDesktopServerChoices(store, LOCAL_URL)).toEqual([
      {
        id: "builtin",
        name: BUILTIN_SERVER_NAME,
        origin: LOCAL_URL,
        kind: "local",
        active: false,
      },
      {
        id: customServerId("https://work.example.test"),
        name: "Devbox",
        origin: "https://work.example.test",
        kind: "custom",
        active: false,
      },
      {
        id: customServerId("https://sandy.example.com/team"),
        name: "sandy.example.com",
        origin: "https://sandy.example.com",
        kind: "custom",
        active: true,
      },
    ]);
  });

  it("hides the built-in server only while another server is saved", async () => {
    const store = createStore();
    await store.setShowBuiltinServer(false);
    expect(buildDesktopServerChoices(store, LOCAL_URL).map((c) => c.id)).toEqual(
      ["builtin"],
    );
    await store.setCustomServerUrl("https://work.example.test");
    expect(buildDesktopServerChoices(store, LOCAL_URL).map((c) => c.id)).toEqual(
      [customServerId("https://work.example.test")],
    );
  });
});
