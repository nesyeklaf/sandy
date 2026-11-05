import { expect } from "@playwright/test";
import { test, fixture, cli, shelf, link, reset, open } from "./helpers.mjs";

test("select mode pins several threads from the bar and archives them with Undo", async ({ page, request }) => {
  await reset(request);
  await open(page);
  const [atlas, birch] = fixture.threads;
  await page.getByRole("button", { name: /^View options:/ }).click();
  await page.getByRole("button", { name: "Select threads", exact: true }).click();
  await page.getByRole("checkbox", { name: `Select ${atlas.title}`, exact: true }).click();
  await page.getByRole("checkbox", { name: `Select ${birch.title}`, exact: true }).click();
  const bar = page.getByRole("toolbar", { name: "Selected threads", exact: true });
  await expect(bar.getByRole("status")).toHaveText("2 selected");
  await bar.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect(link(page, atlas.title, "Pinned")).toBeVisible();
  await expect(link(page, birch.title, "Pinned")).toBeVisible();
  await expect.poll(async () => (await cli(["thread", "get", atlas.id])).thread.pinnedAt).not.toBeNull();

  await page.getByRole("button", { name: /^View options:/ }).click();
  await page.getByRole("button", { name: "Select threads", exact: true }).click();
  await page.getByRole("checkbox", { name: `Select ${atlas.title}`, exact: true }).click();
  await page
    .getByRole("toolbar", { name: "Selected threads", exact: true })
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(page.getByRole("link", { name: new RegExp(`${atlas.title}$`) })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).first().click();
  await expect(link(page, atlas.title, "Pinned")).toBeVisible();
  await expect(shelf(page, "Waiting")).toBeVisible();
});
