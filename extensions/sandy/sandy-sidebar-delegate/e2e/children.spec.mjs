import { expect } from "@playwright/test";
import { seededTest as test } from "./seeds.mjs";
import { cli, rpc, shelf, link, menu, reset, open } from "./helpers.mjs";

test("parent child-thread chip expands and collapses its children", async ({ page, request, family }) => {
  await reset(request);
  await open(page);
  const { parent, children } = family;
  expect((await cli(["thread", "get", parent.id])).thread.status).toBe("idle");
  for (const child of children) {
    // Ownership notifications can start a parent turn asynchronously. This
    // family's parent is disposable so those turns cannot affect later tests.
    await (await menu(page, child.title)).getByRole("menuitem", { name: "Parent", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: parent.title, exact: true }).click();
    await expect.poll(async () => (await cli(["thread", "get", child.id])).thread.parentThreadId).toBe(parent.id);
    await expect(link(page, child.title)).toHaveCount(0);
  }
  const row = shelf(page, "Active")
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: parent.title, exact: true }) });
  const chip = row.getByRole("button", { name: /^2 child threads/ });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  const childList = row.getByRole("list", { name: "Child threads", exact: true });
  await expect(childList).toBeVisible();
  await expect(childList.getByRole("button")).toHaveCount(2);
  for (const { title } of children)
    await expect(childList.getByRole("button", { name: new RegExp(title) })).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await expect(childList).toBeHidden();

  // Settling folds the children; the chip on the Settled row expands them
  // again with a real click, above the row's full-bleed link.
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await rpc(request, "settle", { threadId: parent.id });
  const settled = shelf(page, "Settled");
  const header = settled.getByRole("button", { name: /^Settled/ });
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
  const settledRow = settled
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: new RegExp(parent.title), exact: false }) })
    .first();
  const settledChip = settledRow.getByRole("button", { name: /^2 child threads/ });
  await expect(settledChip).toHaveAttribute("aria-expanded", "false");
  await settledChip.click();
  await expect(settledChip).toHaveAttribute("aria-expanded", "true");
  const settledChildren = settledRow.getByRole("list", { name: "Child threads", exact: true });
  for (const { title } of children)
    await expect(settledChildren.getByRole("button", { name: new RegExp(title) })).toBeVisible();
});
