// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@sandy-sdk/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Value } from "../../core/types";
import { UiRuntimeContext, type UiRuntime } from "../runtime";
import { Holon } from "./Holon";

vi.mock("@sandy-sdk/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  Markdown: ({ children }: { children: string }) => <span>{children}</span>,
  UrlLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useSdk: () => ({ threads: { get: async () => ({}) } }),
  useSettings: () => ({ values: undefined, isLoading: true }),
}));

const openFile = vi.fn(async (_path: string, _line?: number) => true);

const runtime: UiRuntime = {
  setValue() {},
  async run() {},
  openFile,
  loadImage: null,
  holdHeight: () => () => {},
  readText: null,
  loadAudio: null,
  loadAsset: null,
  superseded: false,
  threadId: null,
  blockKey: null,
};

const fixture = (name: string): Value => JSON.parse(readFileSync(`gallery/data/holon/${name}.json`, "utf8")) as Value;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {} }) });
  openFile.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(view: Value): void {
  act(() =>
    root.render(
      <UiRuntimeContext value={runtime}>
        <Holon props={{ view }} />
      </UiRuntimeContext>,
    ),
  );
}

const text = () => container.textContent ?? "";
const labels = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent);
const lights = (list: string) => [...container.querySelectorAll(`ul[aria-label="${list}"] [role="img"]`)].map((element) => element.getAttribute("aria-label"));

describe("Holon", () => {
  it("shows the password reset card: title, kind, Why, Contract, carrier and the four sides with their lights", () => {
    render(fixture("view-password-reset"));
    expect(text()).toContain("Password reset");
    expect(text()).toContain("component");
    expect(text()).toContain("3 drift below");
    expect(text()).toContain("A forgotten password should not turn into a support ticket.");
    expect(text()).toContain("A reset link works once, for 30 minutes, for the address it was sent to.");
    expect(text()).toContain("Identity team");
    expect(lights("Sides")).toEqual(["open", "hard", "hard", "expired"]);
    expect(labels('ul[aria-label="Sides"] li')[1]).toContain("14 tests passed, including expiry and reuse");
    expect(labels('ul[aria-label="Sides"] li')[1]).toContain("apps/account/reset.test.ts");
  });

  it("lists its own drift with the kind and where, and the drift below on parent and parts", () => {
    render(fixture("view-password-reset"));
    expect(labels('ul[aria-label="Drift"] li')).toEqual(["expiredside TheyExpired on 2026-07-30"]);
    expect(text()).toContain("Part of");
    expect(text()).toContain("Account service");
    expect(text()).toContain("4 drift below");
    expect(labels('ul[aria-label="Parts"] li').map((row) => row?.replace(/\s+/g, " "))).toEqual([
      "◇Reset mailoperation1 drift below",
      "◇Reset rate limitoperationproposed1 drift below",
      "○Reset tokenoperation",
    ]);
    expect(lights("Parts")).toEqual(["drift", "drift", "open"]);
  });

  it("opens a code path as a file", () => {
    render(fixture("view-password-reset"));
    const button = container.querySelector<HTMLButtonElement>('ul[aria-label="Code"] button');
    expect(button?.textContent).toContain("apps/account/reset.ts");
    act(() => button?.click());
    expect(openFile).toHaveBeenCalledWith("apps/account/reset.ts", undefined);
  });

  it("shows seams with their contract, read-only and exclusive notes, and the seam drift", () => {
    render(fixture("view-account"));
    const seams = labels('ul[aria-label="Seams"] li');
    expect(seams.length).toBeGreaterThan(0);
    expect(text()).toContain("exclusive");
    expect(text()).toContain("contradiction");
    expect(container.querySelector('ul[aria-label="Seams"] .border-dashed, ul[aria-label="Seams"] .border-destructive')).not.toBeNull();
  });

  it("shows the sign-in card with a side per light", () => {
    render(fixture("view-sign-in"));
    expect(lights("Sides")).toEqual(["soft", "open", "claimed", "open"]);
    expect(text()).toContain("Sign-in");
  });

  it("shows warnings", () => {
    const view = structuredClone(fixture("view-sign-in")) as { warnings: string[] };
    view.warnings = ["two holons share the id sign-in"];
    render(view as unknown as Value);
    expect(labels('ul[aria-label="Warnings"] li')).toEqual(["two holons share the id sign-in"]);
  });

  it("answers a view of another format with one error line, not a crash", () => {
    render({ format: "holon/v0", id: "x" });
    expect(text()).toContain('Holon: format should be "holon-view/v0"');
    expect(container.querySelector('ul[aria-label="Sides"]')).toBeNull();
  });

  it("answers a missing view with an error line", () => {
    render(null);
    expect(text()).toContain("needs a holon-view/v0 object");
  });

  it("pages a few hundred parts instead of drawing them all", () => {
    const view = structuredClone(fixture("view-password-reset")) as { children: unknown[] };
    const first = view.children[0] as { id: string; title: string };
    view.children = Array.from({ length: 300 }, (_, index) => ({ ...first, id: `c${index}`, title: `Part ${index}` }));
    render(view as unknown as Value);
    expect(container.querySelectorAll('ul[aria-label="Parts"] > li').length).toBeLessThan(100);
    expect(text()).toContain("more of 250 parts");
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("more of"));
    act(() => more?.click());
    expect(text()).toContain("more of 200 parts");
  });
});
