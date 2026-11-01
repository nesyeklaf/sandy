import { describe, expect, it } from "vitest";
import {
  MACOS_TRAFFIC_LIGHT_INSET_PX,
  MACOS_TRAFFIC_LIGHT_TOP_INSET_PX,
  RAIL_PADDING_PX,
  WINDOW_CARD_RADIUS_PX,
  type SandyDesktopInfo,
} from "@sandy/desktop-contract";
import { createSandyDesktopApi } from "@/test/sandy-desktop-test-utils";
import {
  DEFAULT_WINDOW_FIND_TOP_OFFSET,
  applyAppFrameGeometry,
  resolveWindowFindTopOffset,
  shouldReserveMacosTrafficLights,
} from "./sandy-desktop";

const desktopInfo: SandyDesktopInfo = {
  platform: "macos",
  version: "0.0.0-test",
};

const macosDesktopApi = createSandyDesktopApi(desktopInfo);

function applyGeometry(
  desktopApi: Parameters<typeof applyAppFrameGeometry>[1],
): Map<string, string> {
  const properties = new Map<string, string>();
  applyAppFrameGeometry(
    {
      style: {
        setProperty: (name: string, value: string) =>
          properties.set(name, value),
      },
    },
    desktopApi,
  );
  return properties;
}

describe("desktop chrome geometry", () => {
  it("reserves macOS traffic-light space only when lights are visible", () => {
    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: macosDesktopApi,
        windowState: { isFullScreen: false },
      }),
    ).toBe(true);
    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: macosDesktopApi,
        windowState: { isFullScreen: true },
      }),
    ).toBe(false);
    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: null,
        windowState: { isFullScreen: false },
      }),
    ).toBe(false);
  });

  it("sizes the title bar around the lights the desktop shell reports", () => {
    const properties = applyGeometry({
      ...macosDesktopApi,
      macosTrafficLightInset: 20,
      macosTrafficLightTopInset: 21,
    });

    expect(properties.get("--sandy-macos-traffic-light-center-y")).toBe("28px");
    expect(properties.get("--sandy-window-title-bar-height")).toBe("56px");
    expect(properties.get("--sandy-macos-traffic-light-reserve")).toBe(
      "calc(12px + 80px / var(--sandy-zoom, 1))",
    );
    expect(properties.get("--sandy-window-title-bar-controls-end")).toBe(
      "calc(var(--sandy-macos-traffic-light-reserve) + 89px)",
    );
    expect(properties.get("--sandy-macos-collapsed-top-left-reserve")).toBe(
      "calc(var(--sandy-macos-traffic-light-reserve) + 20px)",
    );
    expect(
      decodeURIComponent(properties.get("--sandy-window-card-mask") ?? ""),
    ).toContain(
      `<rect y='56' width='100%' height='100%' rx='${WINDOW_CARD_RADIUS_PX}'/>`,
    );
  });

  it("assumes the current light position when the shell reports none", () => {
    const properties = applyGeometry(macosDesktopApi);

    expect(properties.get("--sandy-window-title-bar-height")).toBe(
      `${2 * (MACOS_TRAFFIC_LIGHT_TOP_INSET_PX + 7)}px`,
    );
    expect(properties.get("--sandy-macos-traffic-light-reserve")).toBe(
      `calc(12px + ${MACOS_TRAFFIC_LIGHT_INSET_PX + 60}px / var(--sandy-zoom, 1))`,
    );
  });

  it("writes the frame sizes everywhere but the title bar only on macOS", () => {
    const properties = applyGeometry(null);

    expect(properties.get("--sandy-frame-rail-padding")).toBe(
      `${RAIL_PADDING_PX}px`,
    );
    expect(properties.has("--sandy-window-title-bar-height")).toBe(false);
  });
});

describe("resolveWindowFindTopOffset", () => {
  it.each([
    { chromeRowHeight: "3rem", rootFontSize: "20px", expected: 60 },
    {
      chromeRowHeight: "",
      rootFontSize: "16px",
      expected: DEFAULT_WINDOW_FIND_TOP_OFFSET,
    },
    {
      chromeRowHeight: "4vh",
      rootFontSize: "16px",
      expected: DEFAULT_WINDOW_FIND_TOP_OFFSET,
    },
  ])(
    "resolves $chromeRowHeight against a $rootFontSize root to $expected",
    ({ chromeRowHeight, rootFontSize, expected }) => {
      expect(resolveWindowFindTopOffset(chromeRowHeight, rootFontSize)).toBe(
        expected,
      );
    },
  );
});
