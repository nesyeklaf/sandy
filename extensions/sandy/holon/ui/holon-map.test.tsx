// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import type { MapHolon } from "../core/outputs";
import { HolonMap } from "./HolonMap";
import { buildModel } from "./holon-map-graph";

function holon(id: string, parent: string | null, childCount: number, extra: Partial<MapHolon> = {}): MapHolon {
  return {
    id,
    kind: "component",
    title: id.toUpperCase(),
    status: "active",
    parent,
    file: `${id}.holon`,
    light: "soft",
    sides: { I: "hard", It: "soft", We: "open", They: "refuted" },
    drift: [],
    driftBelow: 0,
    childCount,
    carriedBy: [],
    ...extra,
  };
}

const model = buildModel({
  format: "holon-map/v0",
  holons: [holon("shop", null, 2), holon("cart", "shop", 1), holon("pay", "shop", 0, { driftBelow: 3 }), holon("coupon", "cart", 0)],
  seams: [{ from: "coupon", to: "pay", contract: "Applies a discount. Then more.", light: "soft", readOnly: false, exclusive: false, drift: null }],
  warnings: [],
  computedAt: "2026-11-08T12:00:00Z",
  commit: "fixture",
});

const mounted: Array<() => void> = [];

function render(props: { selected: string; onSelect(id: string): void }) {
  const slot = renderSlot({ component: HolonMap }, { model, ...props });
  mounted.push(() => slot.unmount());
  return slot;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  cleanup();
});

describe("HolonMap", () => {
  it("opens the ancestors of the selected holon and shows the path", async () => {
    const view = render({ selected: "coupon", onSelect: () => undefined });
    await view.findByRole("button", { name: /^COUPON, component/ });
    expect(view.getByRole("button", { name: /^CART, component/ })).toBeTruthy();
    const crumbs = [...view.getByRole("navigation").querySelectorAll("button")].map((button) => button.textContent);
    expect(crumbs).toEqual(["SHOP", "CART", "COUPON"]);
    expect(view.getByRole("button", { name: /^COUPON, component/ }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByText("Applies a discount")).toBeTruthy();
  });

  it("closes a box with its toggle and hides the parts", async () => {
    const view = render({ selected: "coupon", onSelect: () => undefined });
    await view.findByRole("button", { name: /^COUPON, component/ });
    fireEvent.click(view.getByRole("button", { name: "Close CART" }));
    await waitFor(() => expect(view.queryByRole("button", { name: /^COUPON, component/ })).toBeNull());
    expect(view.getByRole("button", { name: "Open CART" })).toBeTruthy();
  });

  it("reports the clicked box and marks the side that recolours the boxes", async () => {
    const picked: string[] = [];
    const view = render({ selected: "cart", onSelect: (id) => picked.push(id) });
    fireEvent.click(await view.findByRole("button", { name: /^PAY, component/ }));
    expect(picked).toEqual(["pay"]);
    fireEvent.click(view.getByRole("button", { name: "They" }));
    await waitFor(() => expect(view.getByRole("button", { name: "They" }).getAttribute("aria-pressed")).toBe("true"));
    expect(view.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelectorAll(".fill-destructive").length).toBeGreaterThan(0);
  });
});
