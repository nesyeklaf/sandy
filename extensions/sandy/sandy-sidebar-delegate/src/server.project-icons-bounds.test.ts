import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";
import { createFakePluginHost, disposers, standardProject } from "./test-server";

const MINUTE = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
});

async function iconHost(fileContent: (args: { path: string }) => Promise<never>) {
  const project = standardProject();
  const { sandy, harness } = createFakePluginHost({
    pluginId: "sandy-sidebar",
    sdk: { projects: { get: async () => project, fileContent } },
  });
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  const fetchIcon = () => harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
  const probes = () => harness.inspection.sdk.callsTo("projects.fileContent").length;
  return { fetchIcon, probes };
}

function clock() {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return (ms: number) => {
    now += ms;
  };
}

describe("project icon probing bounds", () => {
  it("keeps a missing icon for an hour before probing the project again", async () => {
    const advance = clock();
    const { fetchIcon, probes } = await iconHost(async () => {
      throw new Error("not found");
    });

    expect((await fetchIcon()).status).toBe(404);
    const firstProbes = probes();
    expect(firstProbes).toBeGreaterThan(0);

    advance(59 * MINUTE);
    expect((await fetchIcon()).status).toBe(404);
    expect(probes()).toBe(firstProbes);

    advance(2 * MINUTE);
    expect((await fetchIcon()).status).toBe(404);
    expect(probes()).toBe(firstProbes * 2);
  });

  it("stops probing at the first unavailable read and backs off while the host stays offline", async () => {
    const advance = clock();
    const { fetchIcon, probes } = await iconHost(async () => {
      throw Object.assign(new Error("Host host_1 is not connected"), { status: 502 });
    });

    expect((await fetchIcon()).status).toBe(503);
    expect(probes()).toBe(1);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await fetchIcon()).status).toBe(503);
    }
    expect(probes()).toBe(1);

    advance(31_000);
    expect((await fetchIcon()).status).toBe(503);
    expect(probes()).toBe(2);

    advance(31_000);
    expect((await fetchIcon()).status).toBe(503);
    expect(probes()).toBe(2);

    advance(31_000);
    expect((await fetchIcon()).status).toBe(503);
    expect(probes()).toBe(3);
  });
});
