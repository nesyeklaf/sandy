import { describe, expect, it } from "vitest";
import {
  PROFILE_INDEX_STORAGE_KEY,
  createProfileStore,
  profileStorageKey,
} from "./profile-store";
import { createMemorySecureStorage } from "./secure-storage";

function makeStore(storage = createMemorySecureStorage()) {
  let counter = 0;
  const store = createProfileStore({
    storage,
    now: () => 1_700_000_000_000,
    generateId: () => `id-${++counter}`,
  });
  return { store, storage };
}

const direct = {
  mode: "direct" as const,
  serverUrl: "http://127.0.0.1:20304",
  label: "Simulator",
};
const remote = {
  mode: "direct" as const,
  serverUrl: "https://bee.example.test",
  label: "bee",
};

describe("profile store", () => {
  it("persists one key per profile plus an index, and activates the first profile", async () => {
    const { store, storage } = makeStore();
    await store.load();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(remote);

    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      activeProfileId: a.id,
      profiles: [a, b],
    });
    expect(JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!)).toEqual(
      {
        ids: [a.id, b.id],
        activeProfileId: a.id,
      },
    );
    expect(JSON.parse(storage.entries.get(profileStorageKey(b.id))!)).toEqual({
      ...remote,
      id: b.id,
      createdAt: 1_700_000_000_000,
    });
  });

  it("reloads from storage in a fresh store", async () => {
    const { store, storage } = makeStore();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(remote);
    await store.setActiveProfile(b.id);

    const { store: reloaded } = makeStore(storage);
    const state = await reloaded.load();
    expect(state.profiles).toEqual([a, b]);
    expect(state.activeProfileId).toBe(b.id);
    expect(reloaded.getSnapshot().activeProfileId).toBe(b.id);
  });

  it("removeProfile deletes the key, heals the active id, and notifies listeners", async () => {
    const { store, storage } = makeStore();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(remote);
    let notified = 0;
    store.subscribe(() => notified++);

    await store.removeProfile(a.id);
    expect(store.listProfiles()).toEqual([b]);
    expect(store.getSnapshot().activeProfileId).toBe(b.id);
    expect(storage.entries.has(profileStorageKey(a.id))).toBe(false);
    expect(notified).toBeGreaterThan(0);

    await store.removeProfile(b.id);
    expect(store.getSnapshot().activeProfileId).toBeNull();
    expect(JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!)).toEqual(
      {
        ids: [],
        activeProfileId: null,
      },
    );
  });

  it("updateProfile validates the result", async () => {
    const { store } = makeStore();
    const a = await store.addProfile(direct);

    const renamed = await store.updateProfile(a.id, { label: "Mac" });
    expect(renamed).toEqual({ ...a, label: "Mac" });
    await expect(store.updateProfile(a.id, { label: "" })).rejects.toThrow();
    const moved = await store.updateProfile(a.id, {
      serverUrl: "http://10.0.0.5:38886",
      label: undefined,
    });
    expect(moved).toEqual({ ...renamed, serverUrl: "http://10.0.0.5:38886" });
    await expect(store.updateProfile("nope", { label: "x" })).rejects.toThrow(
      /Unknown/,
    );
  });

  it("setActiveProfile rejects unknown ids and persists the choice", async () => {
    const { store, storage } = makeStore();
    const a = await store.addProfile(direct);
    const b = await store.addProfile(remote);
    await expect(store.setActiveProfile("ghost")).rejects.toThrow(/Unknown/);
    await store.setActiveProfile(b.id);
    expect(store.getSnapshot().activeProfileId).toBe(b.id);
    await store.setActiveProfile(null);
    expect(store.getSnapshot().activeProfileId).toBeNull();
    expect(JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!)).toEqual(
      {
        ids: [a.id, b.id],
        activeProfileId: null,
      },
    );
  });

  it("skips corrupt, missing or retired sandy connect profile records on load and heals the index", async () => {
    const storage = createMemorySecureStorage({
      [PROFILE_INDEX_STORAGE_KEY]: JSON.stringify({
        ids: ["good", "missing", "corrupt", "legacy-connect"],
        activeProfileId: "missing",
      }),
      [profileStorageKey("good")]: JSON.stringify({
        ...direct,
        id: "good",
        createdAt: 1,
      }),
      [profileStorageKey("corrupt")]: "{not json",
      [profileStorageKey("legacy-connect")]: JSON.stringify({
        id: "legacy-connect",
        mode: "connect",
        serverUrl: "https://bee.example.test",
        label: "bee",
        handle: "bee",
        credential: "sandycm_secret",
        createdAt: 1,
      }),
    });
    const { store } = makeStore(storage);
    const state = await store.load();
    expect(state.profiles.map((p) => p.id)).toEqual(["good"]);
    expect(state.activeProfileId).toBe("good");
    expect(state.loadError).toMatch(/could not be read/);
    expect(JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!)).toEqual(
      {
        ids: ["good"],
        activeProfileId: "good",
      },
    );
  });

  it("refuses profiles that would exceed the SecureStore value limit", async () => {
    const { store } = makeStore();
    await expect(
      store.addProfile({
        ...remote,
        serverUrl: `https://bee.example.test/${"x".repeat(2100)}`,
      }),
    ).rejects.toThrow(/too large/);
    expect(store.listProfiles()).toEqual([]);
  });

  it("serializes concurrent mutations so the index never loses a profile", async () => {
    const { store, storage } = makeStore();
    const [a, b, c] = await Promise.all([
      store.addProfile(direct),
      store.addProfile(remote),
      store.addProfile({ ...direct, label: "LAN" }),
    ]);
    expect(
      JSON.parse(storage.entries.get(PROFILE_INDEX_STORAGE_KEY)!).ids,
    ).toEqual([a.id, b.id, c.id]);
  });
});
