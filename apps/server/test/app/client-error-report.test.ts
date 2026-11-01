import { describe, expect, it, vi } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

describe("POST /api/v1/system/client-errors", () => {
  it("writes the browser's error to the server log", async () => {
    await withTestHarness(async ({ app, deps }) => {
      const error = vi.spyOn(deps.logger, "error");
      const response = await app.request("/api/v1/system/client-errors", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "sandy-test-browser",
        },
        body: JSON.stringify({
          source: "react-caught",
          message: "Cannot read properties of undefined",
          stack: "TypeError: Cannot read properties of undefined\n    at Panel",
          componentStack: "\n    at Panel\n    at App",
          path: "/threads/thr_1",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(error).toHaveBeenCalledWith(
        {
          clientComponentStack: "\n    at Panel\n    at App",
          clientErrorSource: "react-caught",
          clientPath: "/threads/thr_1",
          clientStack:
            "TypeError: Cannot read properties of undefined\n    at Panel",
          userAgent: "sandy-test-browser",
        },
        "Client error: Cannot read properties of undefined",
      );
    });
  });

  it("rejects a report from an unknown source", async () => {
    await withTestHarness(async ({ app, deps }) => {
      const error = vi.spyOn(deps.logger, "error");
      const response = await app.request("/api/v1/system/client-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "console",
          message: "x",
          stack: null,
          componentStack: null,
          path: "/",
        }),
      });

      expect(response.status).toBe(400);
      expect(error).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^Client error/u),
      );
    });
  });
});
