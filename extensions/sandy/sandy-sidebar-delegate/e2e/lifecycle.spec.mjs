import { expect } from "@playwright/test";
import { test, fixture, cli, rpc, shelf, link, menu, expand, reset, open, showArchived } from "./helpers.mjs";

test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await open(page);
});

test("park and resume persist across reload", async ({ page, request }) => {
  const thread = fixture.threads[0];
  await (await menu(page, thread.title)).getByRole("menuitem", { name: "Park thread", exact: true }).click();
  await expect(shelf(page, "Snoozed")).toBeVisible();
  await expand(page, "Snoozed");
  await expect(link(page, thread.title, "Snoozed")).toBeVisible();
  await expect(shelf(page, "Snoozed").getByText("Parked", { exact: true })).toBeVisible();
  await expect(link(page, thread.title)).toHaveCount(0);
  await expect
    .poll(async () => (await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === thread.id)?.parkedAt)
    .toBeGreaterThan(0);
  await page.reload();
  await expand(page, "Snoozed");
  await expect(link(page, thread.title, "Snoozed")).toBeVisible();
  await expect(link(page, thread.title)).toHaveCount(0);
  await (await menu(page, thread.title, "Snoozed")).getByRole("menuitem", { name: "Resume", exact: true }).click();
  await expect(link(page, thread.title)).toBeVisible();
  await expect(link(page, thread.title, "Snoozed")).toHaveCount(0);
  expect(
    (await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === thread.id)?.parkedAt ?? null,
  ).toBeNull();
  await page.reload();
  await expect(link(page, thread.title)).toBeVisible();
  await expect(link(page, thread.title, "Snoozed")).toHaveCount(0);
});

test("Clean from an archived row shows zero resources and empty cleanup changes nothing", async ({ page, request }) => {
  const thread = fixture.threads[0];
  await showArchived(page);
  await (await menu(page, thread.title)).getByRole("menuitem", { name: "Settle", exact: true }).click();
  await expect(link(page, thread.title)).toHaveCount(0);
  for (const { id } of fixture.threads.slice(1)) await rpc(request, "settle", { threadId: id });
  await expand(page, "Archived");
  await expect(shelf(page, "Archived").getByRole("link")).toHaveCount(fixture.threads.length);
  const lifecycle = await rpc(request, "listLifecycle");
  const states = [];
  for (const { id } of fixture.threads) {
    states.push((await cli(["thread", "get", id])).thread);
    expect((await cli(["terminal", "list", "--thread", id])).sessions).toEqual([]);
  }
  const [previewResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/rpc/previewSettledCleanup")),
    (await menu(page, thread.title, "Archived"))
      .getByRole("menuitem", { name: "Close terminals and ports…", exact: true })
      .click(),
  ]);
  const dialog = page.getByRole("dialog", { name: "Clean settled resources?", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Review the live resources found on settled threads before closing them.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("No live terminals or thread-owned listening ports found.", { exact: true }),
  ).toBeVisible();
  const { result: preview } = await previewResponse.json();
  expect(preview.threads).toEqual([]);
  expect(preview.skipped).toEqual([]);
  await expect(dialog.getByRole("button", { name: "Clean resources", exact: true })).toHaveCount(0);
  // Empty previews offer Cancel only. Verify the same empty plan via the real
  // cleanup RPC rather than inventing a UI confirmation for zero resources.
  expect(await rpc(request, "cleanSettled", { token: preview.token })).toEqual({
    closedTerminals: 0,
    signalledPorts: [],
    remainingPorts: [],
    skipped: [],
    failed: [],
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await rpc(request, "listLifecycle")).toEqual(lifecycle);
  for (const [index, { id, title }] of fixture.threads.entries()) {
    await expect(link(page, title, "Archived")).toBeVisible();
    expect((await cli(["thread", "get", id])).thread).toEqual(states[index]);
    expect((await cli(["terminal", "list", "--thread", id])).sessions).toEqual([]);
  }
});
