import { expect } from "@playwright/test";
import { seededTest as test } from "./seeds.mjs";
import { fixture, rpc, shelf, link, reset, open } from "./helpers.mjs";

test("project filter remembers multiple projects per window and All repos restores every thread", async ({
  page,
  request,
  secondProject,
}) => {
  await reset(request);
  await open(page, { width: 280 });
  await expect(link(page, secondProject.thread.title)).toBeVisible();
  for (const { title } of fixture.threads) await expect(link(page, title)).toBeVisible();
  await page.getByRole("button", { name: "Repo scope: All repos", exact: true }).click();
  const filter = page.getByRole("combobox", { name: "Filter repos" });
  await filter.fill(secondProject.name);
  await filter.press("Tab");
  await expect(page.getByRole("button", { name: `Pin ${secondProject.name}`, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Unpin ${secondProject.name}`, exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Repo scope: All repos", exact: true })).toBeVisible();
  await filter.fill("");
  await page.getByRole("row", { name: "Sidebar smoke", exact: true }).hover();
  await page.getByRole("dialog").screenshot({ path: test.info().outputPath("project-picker.png") });
  const pickerWidth = await page.getByRole("dialog").evaluate((element) => element.getBoundingClientRect().width);
  const scopeLayout = async () => ({
    headerHeight: await page
      .getByRole("button", { name: /^Repo scope:/ })
      .evaluate((element) => element.getBoundingClientRect().height),
    pinsTop: await page
      .getByRole("group", { name: "Pinned repos" })
      .evaluate((element) => element.getBoundingClientRect().top),
  });
  const unfilteredLayout = await scopeLayout();
  await page.getByRole("row", { name: secondProject.name, exact: true }).click();
  await expect(page.getByRole("button", { name: "Repo scope: 1 project", exact: true })).toBeVisible();
  expect(await scopeLayout()).toEqual(unfilteredLayout);
  await expect(page.getByRole("button", { name: "Reset repo filter", exact: true })).toBeVisible();
  await expect
    .poll(() => page.getByRole("dialog").evaluate((element) => element.getBoundingClientRect().width))
    .toBe(pickerWidth);
  await page.getByRole("dialog").screenshot({ path: test.info().outputPath("project-picker-selected.png") });
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(1);
  await expect(link(page, secondProject.thread.title)).toBeVisible();
  for (const { title } of fixture.threads) await expect(link(page, title)).toHaveCount(0);

  // The picker stays open for a second choice; Enter toggles the filtered result.
  await page.getByRole("combobox", { name: "Filter repos" }).fill("Sidebar smoke");
  await page.getByRole("combobox", { name: "Filter repos" }).press("Enter");
  const selectedLabel = "Repo scope: Sidebar smoke + 1 repo";
  await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);
  const shortcut = page.getByRole("button", { name: `Filter by ${secondProject.name}`, exact: true });
  await expect(shortcut).toBeVisible();
  await expect(shortcut).toHaveAttribute("aria-pressed", "true");
  await shortcut.click();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length);
  await expect(shortcut).toHaveAttribute("aria-pressed", "false");
  await shortcut.click();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);
  await expect(shortcut).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-sandy-sidebar-root]").screenshot({ path: test.info().outputPath("pinned-projects.png") });
  await page.getByRole("button", { name: "Reset repo filter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Repo scope: All repos", exact: true })).toBeVisible();
  await expect(shortcut).toHaveAttribute("aria-pressed", "false");
  // Both pinned shortcuts toggle independently and share their state with the picker.
  expect(await scopeLayout()).toEqual(unfilteredLayout);
  await page.getByRole("button", { name: "Repo scope: All repos", exact: true }).click();
  await page.getByRole("button", { name: "Pin Sidebar smoke", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await shortcut.click();
  expect(await scopeLayout()).toEqual(unfilteredLayout);
  await page.getByRole("button", { name: "Filter by Sidebar smoke", exact: true }).click();
  await expect(page.getByRole("button", { name: "Repo scope: 2 projects", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter by Sidebar smoke", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Repo scope: 2 projects", exact: true }).click();
  await expect(page.getByRole("row", { name: secondProject.name, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("row", { name: "Sidebar smoke", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Unpin Sidebar smoke", exact: true }).click();
  await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();

  const otherWindow = await page.context().newPage();
  try {
    await open(otherWindow);
    await expect(otherWindow.getByRole("button", { name: "Repo scope: All repos", exact: true })).toBeVisible();
    await otherWindow.getByRole("button", { name: "Repo scope: All repos", exact: true }).click();
    await otherWindow.getByRole("row", { name: secondProject.name, exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  } finally {
    await otherWindow.close();
  }

  await page.getByRole("button", { name: selectedLabel, exact: true }).click();
  await page.getByRole("row", { name: "Sidebar smoke", exact: true }).click();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(1);
  await page.getByRole("row", { name: "All repos", exact: true }).click();
  await expect
    .poll(() => page.getByRole("dialog").evaluate((element) => element.getBoundingClientRect().width))
    .toBe(pickerWidth);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Repo scope: All repos", exact: true })).toBeVisible();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);
  for (const { title } of [...fixture.threads, secondProject.thread]) await expect(link(page, title)).toBeVisible();
  await page.getByRole("button", { name: "Repo scope: All repos", exact: true }).click();
  await page.getByRole("button", { name: `Unpin ${secondProject.name}`, exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(shortcut).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("group", { name: "Pinned repos" })).toHaveCount(0);
});

test("custom project color styles persist after reload", async ({ page, request }) => {
  await reset(request);
  await open(page);
  try {
    await page.getByRole("button", { name: /^Settings \(/ }).click();
    await page.getByRole("link", { name: "SANDY Sidebar", exact: true }).click();
    await page.getByRole("switch", { name: "Repo colors", exact: true }).check();
    await page.getByRole("combobox", { name: "Show repo stripes in", exact: true }).selectOption("full");
    await expect.poll(async () => (await rpc(request, "getSidebarSettings")).projectColorsEnabled).toBe(true);
    await page.getByRole("combobox", { name: "Repo", exact: true }).selectOption(fixture.projectId);
    await page.getByLabel("Repo color", { exact: true }).fill("#1f4e79");
    await page.getByRole("button", { name: "Save color", exact: true }).click();
    await expect.poll(async () => (await rpc(request, "getProjectColors")).colors[fixture.projectId]).toBe("#1f4e79");
    await page.getByRole("button", { name: "Home", exact: true }).click();
    const row = shelf(page, "Active")
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: fixture.threads[0].title, exact: true }) });
    for (let pass = 0; pass < 2; pass++) {
      await expect(row.getByText("Sidebar smoke", { exact: true })).toHaveCSS("color", "rgb(31, 78, 121)");
      await expect(row.locator("[data-project-stripe]")).toBeVisible();
      await expect(row.locator("[data-project-stripe]")).toHaveCSS("background-color", "rgb(31, 78, 121)");
      if (pass === 0) await page.reload();
    }
    expect((await rpc(request, "getSidebarSettings")).projectColorsEnabled).toBe(true);
    expect((await rpc(request, "getProjectColors")).colors[fixture.projectId]).toBe("#1f4e79");
  } finally {
    await rpc(request, "setProjectColor", { projectId: fixture.projectId, color: null });
    await rpc(request, "updateSidebarSettings", fixture.defaultSettings);
  }
});
