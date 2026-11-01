import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixels: 20, threshold: 0.1, animations: "disabled" },
  },
  snapshotPathTemplate: "{testDir}/__snapshots__/{platform}/{arg}{ext}",
  outputDir: "../test-results",
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    browserName: "chromium",
    launchOptions: { args: ["--use-mock-keychain"] },
    viewport: { width: 1100, height: 800 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
