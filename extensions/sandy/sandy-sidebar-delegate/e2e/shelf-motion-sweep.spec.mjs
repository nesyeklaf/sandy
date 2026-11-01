import { expect } from "@playwright/test";
import { test, cli, rpc, shelf, reset, open, fixture } from "./helpers.mjs";
import { seed } from "./seeds.mjs";
import { probeShelfToggle } from "./motion-probe.mjs";

test.use({ reducedMotion: "no-preference" });

const SHELVES = ["Pinned", "Active", "Snoozed", "Parked", "Settled"];

// Deterministic, so a failing walk replays the same toggles.
function* walk(seedValue, length) {
  let state = seedValue;
  for (let step = 0; step < length; step++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    yield SHELVES[state % SHELVES.length];
  }
}

async function collapseAll(page) {
  for (const name of SHELVES) {
    const header = shelf(page, name).getByRole("button", { name: new RegExp(`^${name}`), expanded: true });
    if (await header.count()) await page.evaluate(probeShelfToggle, name);
  }
}

test("no shelf or row jumps for any shelf toggle sequence, docked or not", async ({ page, request }) => {
  test.setTimeout(600_000);
  const extra = [];
  const failures = [];
  try {
    await reset(request);
    for (const title of ["Sweep pinned", "Sweep snoozed", "Sweep settled", "Sweep active"]) {
      extra.push(await seed(title));
    }
    const [a, b, c, d] = fixture.threads;
    const [pinned, snoozed, settled] = extra;
    for (const { id } of [a, pinned]) await cli(["thread", "pin", id]);
    for (const { id } of [b, snoozed]) {
      await rpc(request, "snooze", { threadId: id, snoozedUntil: Date.now() + 86_400_000 });
    }
    for (const { id } of [c, settled]) await rpc(request, "settle", { threadId: id });
    await rpc(request, "park", { threadId: d.id });

    for (const docked of [true, false]) {
      await rpc(request, "updateSidebarSettings", { ...fixture.defaultSettings, dockShelves: docked });
      await open(page);
      await expect(page.locator("[data-shelf-dock]")).toHaveCount(docked ? 1 : 0);
      for (const name of SHELVES) await expect(shelf(page, name)).toBeVisible();
      const record = (context, result) => {
        if (result.jumps.length > 0) failures.push({ docked, context, ...result });
      };

      // Open and close one shelf, then open and close another: every ordered pair.
      await collapseAll(page);
      for (const first of SHELVES) {
        for (const second of SHELVES) {
          for (const name of [first, first, second, second]) {
            record(`pair ${first} -> ${second}`, await page.evaluate(probeShelfToggle, name));
          }
        }
      }
      // A walk through mixed open/closed states.
      let step = 0;
      for (const name of walk(docked ? 7 : 11, 60)) {
        record(`walk step ${step++}`, await page.evaluate(probeShelfToggle, name));
      }
      // Rows can change height without any list gaining or losing a row (a
      // status line, a chip, a wrapped title). Later motion must start from the
      // grown layout, not from the positions before the growth.
      await collapseAll(page);
      for (const name of ["Pinned", "Active"]) await page.evaluate(probeShelfToggle, name);
      for (const target of ["Pinned", "Active", "Snoozed"]) {
        await page.evaluate(() => {
          const row = document.querySelector('[data-sandy-sidebar-root] section[aria-label="Active"] li');
          const grow = document.createElement("div");
          grow.dataset.sweepGrowth = "";
          grow.style.height = "37px";
          row.firstElementChild.append(grow);
        });
        record(`after row growth, toggle ${target}`, await page.evaluate(probeShelfToggle, target));
        record(`after row growth, toggle ${target} back`, await page.evaluate(probeShelfToggle, target));
        await page.evaluate(() => {
          for (const node of document.querySelectorAll("[data-sweep-growth]")) node.remove();
        });
      }
    }
  } finally {
    console.log("Shelf motion sweep failures:", JSON.stringify(failures, null, 2));
    await rpc(request, "resume", { threadId: fixture.threads[3].id }).catch(() => {});
    for (const { id } of extra) await cli(["thread", "delete", id, "--yes"]);
  }
  expect(failures).toEqual([]);
});
