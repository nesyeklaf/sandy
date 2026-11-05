// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { recordDateTimeFormats } from "./test-date-format-counter";

const at = Date.UTC(2031, 5, 1, 12);

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function switchBerlinToParis(locale: string) {
  const { formatSnoozeWakeTime } = await import("./lifecycle");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2031, 0, 1)));
  vi.stubEnv("TZ", "Europe/Berlin");
  formatSnoozeWakeTime(at, locale);
  vi.stubEnv("TZ", "Europe/Paris");
  return { formatSnoozeWakeTime, recorder: recordDateTimeFormats() };
}

describe("device zone between zones with the same offsets all year", () => {
  it("keeps the cached zone until the refresh interval passes", async () => {
    const { formatSnoozeWakeTime, recorder } = await switchBerlinToParis("de-DE");
    try {
      vi.advanceTimersByTime(59_000);
      formatSnoozeWakeTime(at, "de-DE");
      expect(recorder.count()).toEqual([]);
      vi.advanceTimersByTime(2_000);
      formatSnoozeWakeTime(at, "de-DE");
      expect(recorder.count()).toContain("Europe/Paris");
    } finally {
      recorder.restore();
    }
  });

  it.each([
    ["window focus", () => window.dispatchEvent(new Event("focus"))],
    ["visibilitychange", () => document.dispatchEvent(new Event("visibilitychange"))],
  ])("re-reads the zone on %s", async (_name, fire) => {
    const locale = "fr-FR";
    const { formatSnoozeWakeTime, recorder } = await switchBerlinToParis(locale);
    try {
      fire();
      formatSnoozeWakeTime(at, locale);
      expect(recorder.count()).toContain("Europe/Paris");
    } finally {
      recorder.restore();
    }
  });
});
