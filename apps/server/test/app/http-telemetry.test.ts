import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { startTelemetry } from "@sandy/telemetry";
import { startOtlpReceiver } from "@sandy/telemetry/testing";
import { afterEach, describe, expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

const INCOMING_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});

describe("HTTP telemetry", () => {
  it("exports a server span and a request duration for API requests", async () => {
    const receiver = await startOtlpReceiver();
    try {
      const telemetry = startTelemetry({
        component: "server",
        env: { SANDY_OTLP_ENDPOINT: receiver.endpoint },
      });
      await withTestHarness(async (harness) => {
        const response = await harness.app.request(
          "/api/v1/system/config?token=do-not-export",
          {
            headers: {
              traceparent: `00-${INCOMING_TRACE_ID}-00f067aa0ba902b7-01`,
            },
          },
        );
        expect(response.status).toBe(200);
      });
      await telemetry.shutdown();

      const traces = receiver.requests.find(
        (request) => request.path === "/v1/traces",
      );
      const exportedMetrics = receiver.requests.find(
        (request) => request.path === "/v1/metrics",
      );
      expect(traces?.body.includes("GET /api/v1/system/config")).toBe(true);
      expect(traces?.body.includes(Buffer.from(INCOMING_TRACE_ID, "hex"))).toBe(
        true,
      );
      expect(traces?.body.includes("do-not-export")).toBe(false);
      expect(
        exportedMetrics?.body.includes("http.server.request.duration"),
      ).toBe(true);
    } finally {
      await receiver.close();
    }
  });
});
