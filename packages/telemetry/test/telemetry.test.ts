import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import {
  markSpanFailed,
  startTelemetry,
  withIncomingSpan,
  withOutgoingSpan,
} from "../src/index.js";
import { startOtlpReceiver } from "../src/testing.js";

afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
});

describe("startTelemetry", () => {
  it("registers nothing when no OTLP endpoint is configured", async () => {
    const telemetry = startTelemetry({ component: "server", env: {} });
    const span = trace.getTracer("probe").startSpan("probe");
    expect(span.isRecording()).toBe(false);
    span.end();
    await telemetry.shutdown();
  });

  it("exports spans and metrics to the configured endpoint on shutdown", async () => {
    const receiver = await startOtlpReceiver();
    try {
      const telemetry = startTelemetry({
        component: "host-daemon",
        env: { SANDY_OTLP_ENDPOINT: receiver.endpoint, SANDY_APP_VERSION: "9.9.9" },
      });
      trace.getTracer("probe").startActiveSpan("probe-span", (span) => {
        span.end();
      });
      metrics.getMeter("probe").createCounter("probe_counter").add(3);
      await telemetry.shutdown();

      const traces = receiver.requests.find(
        (request) => request.path === "/v1/traces",
      );
      const exportedMetrics = receiver.requests.find(
        (request) => request.path === "/v1/metrics",
      );
      expect(traces?.contentType).toBe("application/x-protobuf");
      expect(traces?.body.includes("probe-span")).toBe(true);
      expect(traces?.body.includes("sandy-host-daemon")).toBe(true);
      expect(traces?.body.includes("9.9.9")).toBe(true);
      expect(exportedMetrics?.body.includes("probe_counter")).toBe(true);
    } finally {
      await receiver.close();
    }
  });

  it("carries the trace from an outgoing span to the incoming side", async () => {
    const receiver = await startOtlpReceiver();
    try {
      const telemetry = startTelemetry({
        component: "server",
        env: { SANDY_OTLP_ENDPOINT: receiver.endpoint },
      });
      const seen = await withOutgoingSpan(
        { name: "host-rpc probe" },
        async (traceparent, outgoing) => {
          const incomingTraceId = await withIncomingSpan(
            { name: "host-rpc probe", traceparent },
            async (incoming) => {
              markSpanFailed(incoming, "probe_failed");
              return incoming.spanContext().traceId;
            },
          );
          return {
            incomingTraceId,
            outgoingTraceId: outgoing.spanContext().traceId,
            traceparent,
          };
        },
      );
      await expect(
        withIncomingSpan(
          { name: "throws", traceparent: undefined },
          async () => {
            throw new Error("handler exploded");
          },
        ),
      ).rejects.toThrow("handler exploded");
      await telemetry.shutdown();

      expect(seen.traceparent).toMatch(
        new RegExp(`^00-${seen.outgoingTraceId}-[0-9a-f]{16}-01$`),
      );
      expect(seen.incomingTraceId).toBe(seen.outgoingTraceId);
      const traces = receiver.requests.find(
        (request) => request.path === "/v1/traces",
      );
      expect(traces?.body.includes("probe_failed")).toBe(true);
      expect(traces?.body.includes("handler exploded")).toBe(true);
    } finally {
      await receiver.close();
    }
  });

  it("passes no traceparent while telemetry is off", async () => {
    const traceparent = await withOutgoingSpan(
      { name: "host-rpc probe" },
      async (value) => value,
    );
    expect(traceparent).toBeUndefined();
  });
});
