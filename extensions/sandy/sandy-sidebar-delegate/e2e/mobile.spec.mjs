import { expect } from "@playwright/test";
import { test, fixture, reset, link } from "./helpers.mjs";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "no-preference" });

test("mobile sidebar opens a thread", async ({ page, request }) => {
  await reset(request);
  await page.goto(fixture.url);
  const toggle = page.getByRole("button", { name: /Toggle sidebar/i });
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(link(page, fixture.threads[0].title)).toBeVisible();
  expect(
    await page
      .locator("[data-sandy-sidebar-root] *")
      .evaluateAll((nodes) => nodes.filter((node) => "__aa_tgt" in node).length),
  ).toBe(0);
  await link(page, fixture.threads[0].title).tap();
  await expect(page).toHaveURL(new RegExp(fixture.threads[0].id));
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(link(page, fixture.threads[1].title)).toBeVisible();
  await link(page, fixture.threads[1].title).tap();
  await expect(page).toHaveURL(new RegExp(fixture.threads[1].id));
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
