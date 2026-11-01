// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPerfTraceInputClock } from "../../lib/perf-trace";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";

const CLOCK_KEY = Symbol.for("sandy.perf-trace.clock.v1");

function recordMeasureNames(): string[] {
  const names: string[] = [];
  const original = performance.measure.bind(performance);
  vi.spyOn(performance, "measure").mockImplementation((name, options) => {
    names.push(name);
    return original(name, options);
  });
  return names;
}

async function settleTrace(names: string[]): Promise<void> {
  await vi.waitFor(() => expect(names).toContain("sandy:open"));
}

function DialogHarness({ open }: { open: boolean }) {
  return (
    <Dialog open={open}>
      <DialogContent>
        <DialogTitle>Title</DialogTitle>
        <DialogDescription>Body</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

describe("overlay open trace", () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, CLOCK_KEY);
    installPerfTraceInputClock(new EventTarget());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, CLOCK_KEY);
  });

  it("records one render and paint phase when a dialog opens", async () => {
    const names = recordMeasureNames();
    const view = render(<DialogHarness open={false} />);
    expect(names).toEqual([]);

    view.rerender(<DialogHarness open />);
    await settleTrace(names);

    expect(names).toEqual(["sandy:open:render", "sandy:open:paint", "sandy:open"]);
  });

  it("records one open when a dialog mounts already open", async () => {
    const names = recordMeasureNames();
    render(<DialogHarness open />);
    await settleTrace(names);

    expect(names.filter((name) => name === "sandy:open")).toHaveLength(1);
  });

  it("records one render and paint phase when an alert dialog opens", async () => {
    const names = recordMeasureNames();
    const view = render(
      <AlertDialog open={false}>
        <AlertDialogContent>
          <AlertDialogTitle>Sure?</AlertDialogTitle>
          <AlertDialogDescription>Body</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );
    view.rerender(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Sure?</AlertDialogTitle>
          <AlertDialogDescription>Body</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );
    await settleTrace(names);

    expect(names).toEqual(["sandy:open:render", "sandy:open:paint", "sandy:open"]);
  });

  it("records one render and paint phase when a context menu opens", async () => {
    const names = recordMeasureNames();
    const view = render(
      <ContextMenu>
        <ContextMenuTrigger>
          <div data-testid="target">target</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    expect(names).toEqual([]);

    const target = view.getByTestId("target");
    await act(async () => {
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    await settleTrace(names);

    expect(names).toEqual(["sandy:open:render", "sandy:open:paint", "sandy:open"]);
  });
});
