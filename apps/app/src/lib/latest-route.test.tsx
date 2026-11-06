// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  LatestRouteProvider,
  useGetLocation,
  useStableNavigate,
} from "./latest-route";

afterEach(cleanup);

interface Probe {
  navigate: ReturnType<typeof useStableNavigate>;
  getLocation: ReturnType<typeof useGetLocation>;
  stableNavigates: ReturnType<typeof useStableNavigate>[];
  goTo: ReturnType<typeof useNavigate>;
  location: ReturnType<typeof useLocation>;
  stableRenders: number;
}

function mountProbe(initialPath: string): Probe {
  const probe = {
    stableNavigates: [],
    stableRenders: 0,
  } as unknown as Probe;
  function Stable() {
    probe.navigate = useStableNavigate();
    probe.getLocation = useGetLocation();
    probe.stableNavigates.push(probe.navigate);
    probe.stableRenders += 1;
    return null;
  }
  function Router() {
    probe.goTo = useNavigate();
    probe.location = useLocation();
    return null;
  }
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LatestRouteProvider>
        <Router />
        <Stable />
      </LatestRouteProvider>
    </MemoryRouter>,
  );
  return probe;
}

describe("latest-route", () => {
  it("keeps one navigate identity and never re-renders its caller on route changes", () => {
    const probe = mountProbe("/a");
    const rendersAfterMount = probe.stableRenders;

    act(() => void probe.goTo("/b"));
    act(() => void probe.goTo("/c"));

    expect(probe.stableRenders).toBe(rendersAfterMount);
    expect(new Set(probe.stableNavigates).size).toBe(1);
  });

  it("resolves a search-only target against the route at call time", () => {
    const probe = mountProbe("/a");
    act(() => void probe.goTo("/b"));

    act(() => void probe.navigate({ search: "?tab=2" }));

    expect(probe.location.pathname).toBe("/b");
    expect(probe.location.search).toBe("?tab=2");
  });

  it("passes replace and state through and supports history deltas", () => {
    const probe = mountProbe("/a");
    act(() => void probe.goTo("/b"));
    act(() => void probe.navigate("/c", { replace: true, state: { n: 1 } }));

    expect(probe.location.pathname).toBe("/c");
    expect(probe.location.state).toEqual({ n: 1 });

    act(() => void probe.navigate(-1));
    expect(probe.location.pathname).toBe("/a");
  });

  it("reports the current location at call time", () => {
    const probe = mountProbe("/a");
    const getLocation = probe.getLocation;
    act(() => void probe.goTo("/b?x=1"));

    expect(getLocation().pathname).toBe("/b");
    expect(getLocation().search).toBe("?x=1");
  });
});
