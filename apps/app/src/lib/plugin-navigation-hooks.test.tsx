// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { SandyNavigate } from "@sandy-sdk/plugin-sdk";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { LatestRouteProvider } from "./latest-route";
import { useSandyNavigate } from "./plugin-navigation-hooks";

afterEach(cleanup);

interface Probe {
  navigates: SandyNavigate[];
  routerNavigate: ReturnType<typeof useNavigate> | null;
  location: { pathname: string; type: string };
}

function mountProbe(pluginId: string, initialPath: string): Probe {
  const probe: Probe = {
    navigates: [],
    routerNavigate: null,
    location: { pathname: "", type: "" },
  };
  function Consumer() {
    probe.navigates.push(useSandyNavigate());
    probe.routerNavigate = useNavigate();
    probe.location = {
      pathname: useLocation().pathname,
      type: useNavigationType(),
    };
    return null;
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <LatestRouteProvider>
          <PluginSlotMount pluginId={pluginId} slotKind="test" slotId="probe">
            <Consumer />
          </PluginSlotMount>
        </LatestRouteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return probe;
}

function goTo(probe: Probe, path: string) {
  act(() => {
    void probe.routerNavigate?.(path);
  });
}

describe("useSandyNavigate", () => {
  it("returns the same object and functions after the route changes", () => {
    const probe = mountProbe("demo", "/threads/thr_a");
    const first = probe.navigates.at(-1);
    goTo(probe, "/threads/thr_b");
    goTo(probe, "/plugins/demo/panel");

    expect(probe.location.pathname).toBe("/plugins/demo/panel");
    expect(probe.navigates.length).toBeGreaterThan(1);
    for (const navigate of probe.navigates) {
      expect(navigate).toBe(first);
    }
  });

  it("still navigates with the router of the current render after the route changed", () => {
    const probe = mountProbe("demo", "/threads/thr_a");
    const navigate = probe.navigates.at(-1);
    goTo(probe, "/threads/thr_b");

    act(() => navigate?.toPluginPanel("settings"));

    expect(probe.location.pathname).toBe("/plugins/demo/settings");
  });

  it("decides at call time whether compose replaces an automation edit route", () => {
    const probe = mountProbe("automations", "/plugins/automations/automations");
    const navigate = probe.navigates.at(-1);

    act(() => navigate?.toCompose());
    expect(probe.location.type).toBe("PUSH");

    goTo(probe, "/plugins/automations/automations/proj_1/auto_1/edit");
    act(() => navigate?.toCompose());

    expect(probe.location.pathname).toBe("/");
    expect(probe.location.type).toBe("REPLACE");
  });

  it("does not re-render a component that only calls useSandyNavigate when the route changes", () => {
    const counts = { renders: 0 };
    const router: { navigate: ReturnType<typeof useNavigate> | null } = {
      navigate: null,
    };
    function Navigator() {
      router.navigate = useNavigate();
      return null;
    }
    function OnlyNavigates() {
      useSandyNavigate();
      counts.renders += 1;
      return null;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/threads/thr_a"]}>
          <LatestRouteProvider>
            <Navigator />
            <PluginSlotMount pluginId="demo" slotKind="test" slotId="probe">
              <OnlyNavigates />
            </PluginSlotMount>
          </LatestRouteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const rendersAfterMount = counts.renders;

    act(() => {
      void router.navigate?.("/threads/thr_b");
    });
    act(() => {
      void router.navigate?.("/plugins/demo/panel");
    });

    expect(rendersAfterMount).toBeGreaterThan(0);
    expect(counts.renders).toBe(rendersAfterMount);
  });
});
