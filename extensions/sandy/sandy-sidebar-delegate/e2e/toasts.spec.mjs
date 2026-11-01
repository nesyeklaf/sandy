import { writeFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { test, fixture, menu, reset, open, link } from "./helpers.mjs";

async function colors(toast) {
  return toast.evaluate((element) => {
    const read = (el) => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, text: css.color, border: css.borderColor };
    };
    const probe = document.createElement("div");
    document.body.append(probe);
    const tokens = (background, text) => {
      probe.style.cssText = `background:var(${background});color:var(${text});border:1px solid var(--border)`;
      return read(probe);
    };
    const surface = tokens("--popover", "--popover-foreground");
    const muted = tokens("--popover", "--muted-foreground").text;
    probe.remove();
    const card = element.getAttribute("data-styled") === "false" ? element.firstElementChild : element;
    const action = [...element.querySelectorAll("button")].find((el) => el.textContent === "Undo");
    // sandy 0.47 draws every toast with its own component; older hosts used Sonner's markup.
    const description = element.querySelector('[data-testid="app-toast-description"], [data-description]');
    return {
      toast: read(card),
      action: read(action),
      description: description ? read(description).text : null,
      surface,
      muted,
    };
  });
}

async function capture(page, toast, testInfo, theme, kind) {
  const result = await colors(toast);
  writeFileSync(testInfo.outputPath(`${theme}-${kind}-colors.json`), JSON.stringify(result, null, 2));
  await page.screenshot({ path: testInfo.outputPath(`${theme}-${kind}.png`) });
  console.log(`${theme} ${kind}: ${JSON.stringify(result)}`);
  return result;
}

// The sidebar's toasts go through sandy's Toaster with its own class, so they
// should be indistinguishable from sandy's native toasts. Compare against the
// native Archive toast instead of fixed tokens so host restyles are followed.
for (const theme of ["dark", "light"]) {
  test(`sidebar toast matches sandy's native toast in ${theme}`, async ({ page, request }, testInfo) => {
    await reset(request);
    await open(page, { theme });
    const thread = fixture.threads[0];
    await (await menu(page, thread.title)).getByRole("menuitem", { name: "Settle", exact: true }).click();
    const toast = page.locator("[data-sonner-toast].sandy-sidebar-toast").filter({ hasText: "Thread settled" });
    await expect(toast).toBeVisible();
    const settled = await capture(page, toast, testInfo, theme, "sidebar");
    const undo = toast.getByRole("button", { name: "Undo", exact: true });
    await undo.hover();
    const settledHover = (await colors(toast)).action;
    await undo.click();
    await expect(link(page, thread.title)).toBeVisible();

    // This bound SDK action renders SANDY's custom Archive toast on the same Toaster.
    await (await menu(page, thread.title)).getByRole("menuitem", { name: "Archive", exact: true }).click();
    const native = page.locator("[data-sonner-toast]").filter({ hasText: "Thread archived" });
    await expect(native).toBeVisible();
    await expect(native).not.toHaveClass(/sandy-sidebar-toast/);
    const archived = await capture(page, native, testInfo, theme, "native");
    const nativeUndo = native.getByRole("button", { name: "Undo", exact: true });
    await nativeUndo.hover();
    const archivedHover = (await colors(native)).action;

    expect(archived.toast).toEqual(archived.surface);
    expect(settled.toast).toEqual(archived.toast);
    expect(settled.action).toEqual(archived.action);
    expect(settledHover).toEqual(archivedHover);
    // Settling the fixture stops its agent session, so the toast describes it.
    expect(settled.description).toBe(settled.muted);
    expect(settled.description).toBe(archived.description);

    await nativeUndo.click();
    await expect(link(page, thread.title)).toBeVisible();
  });
}
