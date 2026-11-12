import { expect } from "@playwright/test";
import { seededTest as test } from "./seeds.mjs";
import { fixture, rpc, reset, open } from "./helpers.mjs";

test("[scratch-entry-point] Spaces open collapsed, expose counts and survive reload", async ({ page, request }) => {
  await reset(request);
  await open(page, { width: 365, listView: null });
  await expect(page.getByRole("radio", { name: "Spaces" })).toBeChecked();
  const noSpace = page.getByRole("button", { name: /^No Space \(\d+\)$/ });
  await expect(noSpace).toHaveAttribute("aria-expanded", "false");
  await noSpace.click();
  await expect(noSpace).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: /^No Space \(\d+\)$/ })).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: test.info().outputPath("spaces-expanded.png") });
});

test("Flow stays selectable and Space overview is readable from the CLI route", async ({ page, request }) => {
  await reset(request);
  await open(page, { width: 365, listView: null });
  await page.getByRole("radio", { name: "Flow" }).click();
  await expect(page.getByRole("radio", { name: "Flow" })).toBeChecked();
  const overview = await rpc(request, "getSpaceOverview", {});
  expect(overview.spaces.reduce((sum, space) => sum + space.total, 0)).toBeGreaterThan(0);
  expect(fixture.threads.length).toBeGreaterThan(0);
});

test("[responsive-density-matrix] header density follows the setting", async ({ page, request }) => {
  await reset(request);
  await rpc(request, "updateSidebarSettings", { ...fixture.defaultSettings, spaceHeaderDensity: "minimal" });
  await open(page, { width: 365, listView: null });
  const header = page.getByRole("button", { name: /^No Space \(\d+\)$/ });
  const minimal = (await header.boundingBox()).height;
  await rpc(request, "updateSidebarSettings", { ...fixture.defaultSettings, spaceHeaderDensity: "detailed" });
  await page.reload();
  expect((await page.getByRole("button", { name: /^No Space \(\d+\)$/ }).boundingBox()).height).toBeGreaterThan(
    minimal,
  );
});
for (const width of [272, 320, 390]) {
  test(`[responsive-density-matrix] Spaces fit without horizontal scroll at ${width}px`, async ({ page, request }) => {
    await reset(request);
    for (const density of ["minimal", "compact", "detailed"]) {
      await rpc(request, "updateSidebarSettings", { ...fixture.defaultSettings, spaceHeaderDensity: density });
      await open(page, { width, listView: null });
      await page.getByRole("button", { name: /^No Space \(\d+\)$/ }).click();
      const overflow = await page
        .locator("[data-list-motion-scroller]")
        .evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow, `${density} at ${width}`).toBeLessThanOrEqual(0);
    }
  });
}
