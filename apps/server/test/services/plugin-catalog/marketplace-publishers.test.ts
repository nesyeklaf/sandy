import { describe, expect, it } from "vitest";
import {
  marketplacePublisherLabel,
  pluginPublisherLabel,
} from "../../../src/services/plugin-catalog/marketplace-publishers.js";

function publisherLabels(
  marketplaces: Array<{ marketplaceName: string; displayName: string }>,
): Map<string, string> {
  return new Map(
    marketplaces.map((marketplace) => [
      marketplace.marketplaceName,
      marketplacePublisherLabel(marketplace),
    ]),
  );
}

describe("marketplace publisher labels", () => {
  it("names each marketplace by its own display name", () => {
    const labels = publisherLabels([
      { marketplaceName: "community", displayName: "Community Plugins" },
      { marketplaceName: "acme", displayName: "Acme Plugins" },
    ]);

    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "catalog",
        catalogMarketplaceName: "community",
        labels,
      }),
    ).toBe("Community Plugins");
    expect(
      pluginPublisherLabel({
        sourceKind: "npm",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("Acme Plugins");
  });

  it("refuses a reserved label to a marketplace that is not SANDY's", () => {
    const labels = publisherLabels([
      { marketplaceName: "acme", displayName: "SANDY Official" },
    ]);

    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("acme");
    expect(
      marketplacePublisherLabel({
        marketplaceName: "acme",
        displayName: "SANDY Community",
      }),
    ).toBe("acme");
  });

  it("keeps a store-installed bundled plugin on SANDY Official", () => {
    const labels = publisherLabels([
      { marketplaceName: "community", displayName: "Community Plugins" },
    ]);

    expect(
      pluginPublisherLabel({
        sourceKind: "builtin",
        provenance: "catalog",
        catalogMarketplaceName: "community",
        labels,
      }),
    ).toBe("SANDY Official");
  });

  it("badges bundled plugins SANDY Official and user installs not at all", () => {
    const labels = publisherLabels([]);

    expect(
      pluginPublisherLabel({
        sourceKind: "builtin",
        provenance: "builtin",
        catalogMarketplaceName: null,
        labels,
      }),
    ).toBe("SANDY Official");
    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "direct",
        catalogMarketplaceName: null,
        labels,
      }),
    ).toBeNull();
  });
});
