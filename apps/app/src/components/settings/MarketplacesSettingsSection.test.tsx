// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNotifications,
  resetNotificationStore,
} from "@/lib/notifications/notification-store";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { MarketplacesSettingsSection } from "./MarketplacesSettingsSection";

const OFFICIAL = {
  name: "sandy-official",
  displayName: "SANDY Official",
  description: null,
  official: true,
  sourceKind: "path",
  source: "path:/bundled",
  resolvedCommit: null,
  entryCount: 3,
  lastRefreshAt: 1_700_000_000_000,
  lastAttemptAt: 1_700_000_000_000,
  lastError: null,
};

const ACME = {
  ...OFFICIAL,
  name: "acme-plugins",
  displayName: "Acme Plugins",
  official: false,
  source: "path:/work/acme-marketplace",
  entryCount: 2,
};

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  marketplaces: unknown[],
  addResponse = Response.json({ ok: true, marketplace: ACME }),
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url === "/api/v1/marketplaces" && init?.method !== "POST") {
        return Response.json({ marketplaces });
      }
      if (url === "/api/v1/marketplaces") {
        return addResponse;
      }
      if (
        url.startsWith("/api/v1/marketplaces/") &&
        init?.method === "DELETE"
      ) {
        return Response.json({ ok: true, convertedPluginIds: ["notes"] });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }),
  );
  return requests;
}

afterEach(() => {
  cleanup();
  resetNotificationStore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarketplacesSettingsSection", () => {
  it("adds a marketplace through the server route", async () => {
    const requests = stubFetch([OFFICIAL]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    fireEvent.change(screen.getByLabelText("Marketplace source"), {
      target: { value: " path:/work/acme-marketplace " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await vi.waitFor(() => {
      const post = requests.find(
        (request) =>
          request.url === "/api/v1/marketplaces" &&
          request.init?.method === "POST",
      );
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        source: "path:/work/acme-marketplace",
      });
    });
  });

  it("offers a subdirectory for a git source and sends it with the source", async () => {
    const requests = stubFetch([OFFICIAL]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    expect(screen.queryByLabelText("Marketplace subdirectory")).toBe(null);
    fireEvent.change(screen.getByLabelText("Marketplace source"), {
      target: { value: "git:https://github.com/acme/agent-plugins.git@main" },
    });
    fireEvent.change(screen.getByLabelText("Marketplace subdirectory"), {
      target: { value: " sandy " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await vi.waitFor(() => {
      const post = requests.find(
        (request) =>
          request.url === "/api/v1/marketplaces" &&
          request.init?.method === "POST",
      );
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        source: "git:https://github.com/acme/agent-plugins.git@main",
        subdirectory: "sandy",
      });
    });
  });

  it("drops a typed subdirectory when the source is no longer a git source", async () => {
    const requests = stubFetch([OFFICIAL]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    fireEvent.change(screen.getByLabelText("Marketplace source"), {
      target: { value: "git:https://github.com/acme/agent-plugins.git" },
    });
    fireEvent.change(screen.getByLabelText("Marketplace subdirectory"), {
      target: { value: "sandy" },
    });
    fireEvent.change(screen.getByLabelText("Marketplace source"), {
      target: { value: "path:/work/acme-marketplace" },
    });
    expect(screen.queryByLabelText("Marketplace subdirectory")).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await vi.waitFor(() => {
      const post = requests.find(
        (request) =>
          request.url === "/api/v1/marketplaces" &&
          request.init?.method === "POST",
      );
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        source: "path:/work/acme-marketplace",
      });
    });
  });

  it("shows the subdirectory a git marketplace is read from", async () => {
    stubFetch([
      OFFICIAL,
      {
        ...ACME,
        sourceKind: "git",
        source: "git:https://acme.test/repo.git@main",
        subdirectory: "sandy",
      },
    ]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    expect(
      await screen.findByText(
        "git:https://acme.test/repo.git@main · subdirectory sandy",
      ),
    ).toBeTruthy();
  });

  it("retains one alert when adding a marketplace fails", async () => {
    stubFetch(
      [OFFICIAL],
      Response.json(
        { error: "marketplace directory does not exist" },
        { status: 400 },
      ),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    fireEvent.change(screen.getByLabelText("Marketplace source"), {
      target: { value: "path:/missing-marketplace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await vi.waitFor(() => {
      expect(getNotifications()).toEqual([
        expect.objectContaining({
          title: "Adding the marketplace failed",
          description: "marketplace directory does not exist",
        }),
      ]);
    });
  });

  it("offers Remove only for marketplaces other than sandy-official", async () => {
    stubFetch([OFFICIAL, ACME]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    await screen.findByText("Acme Plugins");
    expect(screen.queryByRole("button", { name: "Remove SANDY Official" })).toBe(
      null,
    );
    expect(
      screen.getByRole("button", { name: "Remove Acme Plugins" }),
    ).toBeTruthy();
  });

  it("says removal keeps installed plugins running before confirming", async () => {
    const requests = stubFetch([OFFICIAL, ACME]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Acme Plugins" }),
    );
    expect(screen.getByText(/keep running as direct installs/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.url === "/api/v1/marketplaces/acme-plugins" &&
            request.init?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });
});
