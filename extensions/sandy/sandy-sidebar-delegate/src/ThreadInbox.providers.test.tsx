// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it.each(["full", "compact-working", "compact-all", "working-shelf"])(
    "renders provider names, logos, and theme tints from sandy's directory (%s)",
    async (display) => {
      const view = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ providerId: "pi", title: "Pi thread", indicator: "runtime", indicatorLabel: "Working" })],
          projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
        },
        providers: {
          status: "ready",
          providers: [
            {
              id: "pi",
              pluginId: "provider-pi",
              displayName: "Pi",
              available: true,
              completedTurnDisplay: "collapse",
              maintenance: {
                health: true,
                usage: false,
                installation: true,
              },
              logoUrl: "/api/v1/system/providers/pi/logo",
              capabilities: {
                modelCatalogScope: "workspace",
                permissionModes: ["full"],
                supportsFork: true,
                supportsNativeUserQuestion: false,
                supportsServiceTier: false,
                supportsSessionRewind: true,
                supportsThreadArchive: false,
                supportsThreadRename: false,
              },
              composerActions: [],
              strings: {
                signInHint: "Run pi to sign in.",
                expiredHint: "Run pi to sign in again.",
                installUrl: "https://pi.dev",
                iconTint: { light: "#6D5DFB", dark: "#A99EFF" },
              },
            },
          ],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            inactiveThreadsEnabled: false,
            threadDisplay: display === "working-shelf" ? "full" : display,
            workingShelf: display === "working-shelf",
          }),
        },
      });

      await waitFor(() => {
        const row = screen.getByRole("link", { name: "Pi thread" }).closest("[data-parent-card]")!;
        expect(row.classList.contains("h-8")).toBe(display !== "full");
      });
      const region = screen.getByRole("region", { name: display === "working-shelf" ? "Working" : "Needs you" });
      const glyph = within(region).getByRole("img", { name: "Pi" });
      const row = glyph.closest("[data-parent-card]")! as HTMLElement;
      expect(within(row).getByText("Working")).toBeDefined();
      const marks = glyph.querySelectorAll<HTMLElement>("[aria-hidden=true]");
      expect(marks).toHaveLength(2);
      expect(marks[0]!.style.maskImage).toContain("/api/v1/system/providers/pi/logo");
      expect(marks[0]!.style.backgroundColor).toBe("rgb(109, 93, 251)");
      expect(marks[1]!.style.backgroundColor).toBe("rgb(169, 158, 255)");
      expect(view.container.querySelector('[aria-label="pi"]')).toBeNull();
    },
  );

  it("falls back to the provider id when the directory has no match", () => {
    render([thread({ providerId: "custom-agent" })]);

    const glyph = screen.getByRole("img", { name: "custom-agent" });
    expect(glyph.querySelector(".rounded-full")).not.toBeNull();
  });

  it("loads a project favicon beside the project name", async () => {
    const view = render([
      thread({
        id: "icon-thread",
        environment: {
          id: "env_1",
          name: "main",
          branchName: "main",
          workspaceDisplayKind: "other",
          path: null,
          isWorktree: null,
          providerId: null,
        },
      }),
    ]);

    const preload = await waitFor(() => {
      const image = view.container.querySelector<HTMLImageElement>('img[src*="project-icon"]');
      expect(image).not.toBeNull();
      return image!;
    });
    expect(preload.src).toContain("projectId=proj_1");
    expect(preload.src).not.toContain("environmentId");
    fireEvent.load(preload);
    expect(view.container.querySelector('img.object-contain[src*="project-icon"]')).not.toBeNull();
  });
});
