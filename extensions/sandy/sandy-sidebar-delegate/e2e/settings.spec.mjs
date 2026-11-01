import { expect } from "@playwright/test";
import { test, fixture, rpc, shelf, link, reset, open } from "./helpers.mjs";

test("sidebar settings change snooze shortcuts and persist after reload", async ({ page, request }) => {
  await reset(request);
  await open(page);
  await page.getByRole("button", { name: /^Settings \(/ }).click();
  await page.getByRole("link", { name: "SANDY Sidebar", exact: true }).click();
  const shortcuts = page.getByRole("textbox", { name: "Snooze shortcuts", exact: true });
  await expect(shortcuts).toHaveValue(fixture.defaultSettings.snoozePresets);
  await shortcuts.fill("E2E break=45m, 2h");
  await expect.poll(async () => (await rpc(request, "getSidebarSettings")).snoozePresets).toBe("E2E break=45m, 2h");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(shelf(page, "Active")).toBeVisible();
  const thread = fixture.threads[0];
  const row = shelf(page, "Active")
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: thread.title, exact: true }) });
  for (let pass = 0; pass < 2; pass++) {
    await link(page, thread.title).hover();
    await row.getByRole("combobox", { name: "Snooze thread" }).click();
    await expect(page.getByRole("option", { name: "E2E break", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "2 hours", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    if (pass === 0) {
      await page.reload();
      await expect(shelf(page, "Active")).toBeVisible();
    }
  }
  expect((await rpc(request, "getSidebarSettings")).snoozePresets).toBe("E2E break=45m, 2h");
});
