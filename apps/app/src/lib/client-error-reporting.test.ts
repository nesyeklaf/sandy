// @vitest-environment jsdom
import type { ClientErrorReport } from "@sandy/server-contract";
import { describe, expect, it } from "vitest";
import {
  createClientErrorReporter,
  installClientErrorListeners,
} from "./client-error-reporting";

function createRecordingReporter(
  send: (report: ClientErrorReport) => Promise<unknown> = async () => ({
    ok: true,
  }),
) {
  const reports: ClientErrorReport[] = [];
  const reporter = createClientErrorReporter({
    send: (report) => {
      reports.push(report);
      return send(report);
    },
    readPath: () => "/threads/thr_1",
  });
  return { reporter, reports };
}

describe("client error reporting", () => {
  it("reports window errors and unhandled rejections once per message", () => {
    const { reporter, reports } = createRecordingReporter();
    const target = new EventTarget() as unknown as Window;
    const uninstall = installClientErrorListeners(target, reporter);

    const failure = new Error("render loop");
    target.dispatchEvent(
      new ErrorEvent("error", { error: failure, message: "render loop" }),
    );
    target.dispatchEvent(
      new ErrorEvent("error", { error: failure, message: "render loop" }),
    );
    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: "socket closed" });
    target.dispatchEvent(rejection);
    uninstall();
    target.dispatchEvent(
      new ErrorEvent("error", { error: new Error("after uninstall") }),
    );

    expect(reports).toEqual([
      {
        source: "window-error",
        message: "render loop",
        stack: failure.stack,
        componentStack: null,
        path: "/threads/thr_1",
      },
      {
        source: "unhandled-rejection",
        message: "socket closed",
        stack: null,
        componentStack: null,
        path: "/threads/thr_1",
      },
    ]);
  });

  it("stops after twenty distinct errors per page", () => {
    const { reporter, reports } = createRecordingReporter();
    for (let index = 0; index < 30; index += 1) {
      reporter.report("react-caught", new Error(`failure ${index}`));
    }
    expect(reports).toHaveLength(20);
    expect(reports.at(-1)?.message).toBe("failure 19");
  });

  it("keeps reports within the server's size limits", () => {
    const { reporter, reports } = createRecordingReporter();
    const error = new Error("x".repeat(5_000));
    error.stack = "y".repeat(40_000);
    reporter.report("react-uncaught", error, "z".repeat(40_000));
    expect(reports[0]?.message).toHaveLength(2_000);
    expect(reports[0]?.stack).toHaveLength(16_000);
    expect(reports[0]?.componentStack).toHaveLength(16_000);
  });

  it("does not raise when the report cannot be sent", async () => {
    const { reporter, reports } = createRecordingReporter(() =>
      Promise.reject(new Error("offline")),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      reporter.report("window-error", new Error("lost"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(reports).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });
});
