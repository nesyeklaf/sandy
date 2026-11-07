import { useEffect } from "react";
import { definePluginApp, useRpc } from "@sandy-sdk/plugin-sdk/app";
import { isAutomatedBrowser, type Client, type Sample, type rpcContract } from "./contract.ts";
import { createRecordSender } from "./record.ts";
import { startCollector } from "./collector.ts";
import { loadBenchmarkState, scheduleBenchmark } from "./benchmark.ts";
import { startLoadProbe } from "./load.ts";
import { loadDeviceId, readGpu, readPlatform, screenText } from "./device.ts";
import { readRelease, type ReleaseInfo } from "./release.ts";

const FLUSH_INTERVAL_MS = 10000;
const BATCH = 100;
const MAX_QUEUED = 1000;

const queue: Sample[] = [];
const recordSender = createRecordSender();
let release: ReleaseInfo | null = null;
let benchmarkIndex: number | null = null;
let gpu: string | null = null;
let activeRefreshMs: (() => number | null) | null = null;

function enqueue(sample: Sample) {
  queue.push(sample);
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
}

function navigatorNumber(key: string): number | null {
  const value: unknown = Reflect.get(navigator, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function effectiveType(): string | null {
  const connection: unknown = Reflect.get(navigator, "connection");
  if (typeof connection !== "object" || connection === null) return null;
  const type: unknown = Reflect.get(connection, "effectiveType");
  return typeof type === "string" ? type.slice(0, 20) : null;
}

function client(): Client {
  release ??= readRelease(document);
  benchmarkIndex ??= loadBenchmarkState()?.index ?? null;
  return {
    sandyVersion: release.sandyVersion,
    appScript: release.appScript,
    benchmarkIndex,
    deviceMemoryGb: navigatorNumber("deviceMemory"),
    effectiveType: effectiveType(),
    userAgent: navigator.userAgent.slice(0, 400),
    cores: Math.min(1024, navigator.hardwareConcurrency || 0),
    devicePixelRatio: Math.min(16, window.devicePixelRatio || 1),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    deviceId: loadDeviceId(),
    platform: readPlatform(),
    screen: screenText(screen.width, screen.height),
    refreshMs: activeRefreshMs?.() ?? null,
    gpu,
  };
}

function Flusher() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    let sending = false;
    const flush = async () => {
      if (sending || queue.length === 0) return;
      sending = true;
      const batch = queue.splice(0, BATCH);
      try {
        await recordSender.send((input) => rpc.call("record", input), client(), batch);
      } catch {
        queue.unshift(...batch);
        if (queue.length > MAX_QUEUED) queue.splice(MAX_QUEUED);
      } finally {
        sending = false;
      }
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const interval = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onHidden);
      void flush();
    };
  }, [rpc]);
  return null;
}

function scheduleGpuRead(signal: AbortSignal) {
  if (gpu !== null) return;
  const read = () => {
    if (!signal.aborted) gpu = readGpu();
  };
  const timer = setTimeout(() => (typeof requestIdleCallback === "function" ? requestIdleCallback(read, { timeout: 30000 }) : read()), 8000);
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "field-latency-collector",
    mount({ signal }) {
      const automated = isAutomatedBrowser(navigator.userAgent, navigator.webdriver === true);
      const collector = startCollector(automated ? () => {} : enqueue, signal, automated ? null : startLoadProbe(signal));
      activeRefreshMs = collector.refreshMs;
      if (!automated) {
        scheduleBenchmark((index) => {
          benchmarkIndex = index;
        }, signal);
        scheduleGpuRead(signal);
      }
      return () => collector.dispose();
    },
  });
  app.slots.experimental_appOverlay({ id: "field-latency-flusher", component: Flusher });
});
