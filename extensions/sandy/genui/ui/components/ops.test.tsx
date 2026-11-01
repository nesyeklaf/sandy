// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@sandy-sdk/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "../../core/types";
import { useBlockAnswerTarget } from "../LiveUi";
import { AnswersContext, UiRuntimeContext, type TextFile, type UiRuntime } from "../runtime";
import { Approval, Hosts, Job, Runbook } from "./ops";

vi.mock("@sandy-sdk/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  useSettings: () => ({ values: undefined, isLoading: true }),
  useComposers: () => [],
}));

const run = vi.fn(async (_actions: readonly Action[]) => {});
const readText = vi.fn(async (_path: string, _options?: { readonly fresh?: boolean }): Promise<TextFile> => ({ ok: true, text: "" }));
const runtime: UiRuntime = {
  setValue() {},
  run,
  openFile: null,
  loadImage: null,
  holdHeight: () => () => {},
  readText,
  loadAudio: null,
  loadAsset: null,
  superseded: false,
  threadId: null,
  blockKey: null,
};

let blockKey = "";
function Block({ children }: { children: ReactNode }) {
  const answers = useBlockAnswerTarget({ kind: "gallery" }, blockKey, false, () => 0);
  return <AnswersContext value={answers}>{children}</AnswersContext>;
}

let container: HTMLDivElement;
let root: Root;
let blocks = 0;
beforeEach(() => {
  blockKey = `ops.test:${++blocks}`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: () => ({ cancel() {} }) });
  run.mockClear();
  readText.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(element: ReactNode): void {
  act(() =>
    root.render(
      <UiRuntimeContext value={runtime}>
        <Block>{element}</Block>
      </UiRuntimeContext>,
    ),
  );
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(name) || button.getAttribute("aria-label") === name);
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

describe("Approval", () => {
  it("warns about changes with no way back and offers Approve and Decline", () => {
    render(<Approval props={{ changes: [{ kind: "delete", target: "old/" }, { kind: "write", target: "a.txt", revert: "git checkout a.txt" }] }} />);
    expect(container.textContent).toContain("One change names no way back.");
    expect(container.textContent).toContain("No way back given");
    expect(container.textContent).toContain("Undo: git checkout a.txt");
    expect(buttonNamed("Approve")).toBeTruthy();
    expect(buttonNamed("Decline")).toBeTruthy();
  });

  it("shows a reader error for a malformed list", () => {
    render(<Approval props={{ changes: "x" }} />);
    expect(container.textContent).toContain("Approval takes a list of changes");
  });
});

describe("Hosts", () => {
  it("groups hosts by outcome, worst first, and copies a group's host names", async () => {
    render(<Hosts props={{ items: [{ host: "a", status: "ok" }, { host: "b", status: "failed" }, { host: "c", status: "failed" }] }} />);
    const groups = [...container.querySelectorAll("section section")].map((section) => section.getAttribute("aria-label"));
    expect(groups).toEqual(["Failed", "OK"]);
    await act(async () => buttonNamed("Copy the failed hosts").click());
    expect(run).toHaveBeenCalledWith([{ kind: "action", type: "copy", text: "b\nc" }]);
  });
});

describe("Runbook", () => {
  it("offers a report only once a step is marked", async () => {
    render(<Runbook props={{ steps: [{ title: "Restart", command: "systemctl restart app" }, "Check"] }} />);
    expect(container.textContent).toContain("Mark a step to report back.");
    await act(async () => [...container.querySelectorAll('[aria-label="Step 2 result"] button')][1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(buttonNamed("Report back")).toBeTruthy();
    await act(async () => buttonNamed("Copy the command of step 1").click());
    expect(run).toHaveBeenCalledWith([{ kind: "action", type: "copy", text: "systemctl restart app" }]);
  });
});

describe("Job", () => {
  it("reads the status file afresh until it says it finished", async () => {
    vi.useFakeTimers();
    readText
      .mockResolvedValueOnce({ ok: true, text: '{"status":"running","done":1,"total":4}' })
      .mockResolvedValueOnce({ ok: true, text: '{"status":"done","done":4,"total":4}' });
    render(<Job props={{ path: "job.json" }} />);
    await act(async () => {});
    expect(readText).toHaveBeenCalledWith("job.json", { fresh: true });
    expect(container.textContent).toContain("Running · 1 of 4");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("Done · 4 of 4");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("says it gave up when the status file never appeared", async () => {
    vi.useFakeTimers();
    readText.mockResolvedValue({ ok: false, error: "no such file" });
    render(<Job props={{ path: "job.json" }} />);
    await act(async () => {});
    expect(container.textContent).toContain("Waiting for the status file (no such file).");
    await act(async () => vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 10_000));
    expect(container.textContent).toContain("stopped following after 2 hours");
    expect(container.textContent).not.toContain("Waiting for the status file");
    const calls = readText.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(readText).toHaveBeenCalledTimes(calls);
  });

  it("stops the spinner and says why when the status file vanishes while running", async () => {
    vi.useFakeTimers();
    readText.mockResolvedValueOnce({ ok: true, text: '{"status":"running","done":1,"total":4}' }).mockResolvedValue({ ok: false, error: "no such file" });
    render(<Job props={{ path: "job.json" }} />);
    await act(async () => {});
    expect(container.querySelector('[data-icon="Loader"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("can no longer be read (no such file)");
    await act(async () => vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 10_000));
    expect(container.textContent).toContain("stopped following after 2 hours");
    expect(container.querySelector('[data-icon="Loader"]')).toBeNull();
  });
});
