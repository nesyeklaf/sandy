import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { test as base, expect } from "@playwright/test";

if (!process.env.E2E_FIXTURE) throw new Error("Use npm run e2e so the scratch launcher owns the server");
export const fixture = JSON.parse(readFileSync(process.env.E2E_FIXTURE, "utf8"));
if (new URL(fixture.url).port === "38886" || !fixture.env.SANDY_DATA_DIR.startsWith("/tmp/sandy-sidebar-smoke-")) {
  throw new Error("E2E fixture must target a scratch server");
}

for (const key of [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "TMPDIR",
]) {
  if (!fixture.env[key]?.startsWith(`${fixture.env.SANDY_DATA_DIR}/`))
    throw new Error(`CLI ${key} must be inside scratch`);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /\[plugin:sandy-sidebar(-delegate)?\]|is not a function|ReferenceError|TypeError/.test(message.text())
      ) {
        errors.push(message.text());
      }
    });
    await use(page);
    expect(errors, "sidebar/browser JavaScript errors").toEqual([]);
  },
});

export async function cli(args) {
  const { stdout } = await promisify(execFile)(fixture.sandy, [...args, "--json"], {
    env: fixture.env,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

export async function rpc(request, method, input = {}) {
  const response = await request.post(`${fixture.url}/api/v1/plugins/sandy-sidebar-delegate/rpc/${method}`, {
    data: input,
  });
  expect(response.ok(), `RPC ${method}: ${await response.text()}`).toBe(true);
  const payload = await response.json();
  expect(payload.ok, `RPC ${method} failed`).toBe(true);
  return payload.result;
}

export function shelf(page, name) {
  return page.getByRole("region", { name, exact: true });
}

export function link(page, title, name = "Waiting") {
  return shelf(page, name).getByRole("link", { name: new RegExp(`${title}$`) });
}

export async function menu(page, title, name = "Waiting") {
  await link(page, title, name).click({ button: "right" });
  return page.getByRole("menu", { name: "Thread actions", exact: true });
}

export async function expand(page, name) {
  const header = shelf(page, name).getByRole("button", { name: new RegExp(`^${name}`) });
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
}

export async function reset(request) {
  await rpc(request, "updateSidebarSettings", fixture.defaultSettings);
  for (const thread of fixture.threads) {
    await cli(["thread", "unpin", thread.id]);
    await cli(["thread", "read", thread.id]);
    await rpc(request, "unsnooze", { threadId: thread.id });
    await rpc(request, "unsettle", { threadId: thread.id });
  }
  await rpc(request, "reorderInbox", { inboxThreadIds: fixture.threads.map(({ id }) => id) });
}

export async function open(page, { theme = "light", width = 320, empty = false, listView = "flow" } = {}) {
  const storeWidth = (stored) =>
    page.addInitScript((value) => localStorage.setItem("sandy.sidebar.width", String(value)), stored);
  await page.addInitScript((theme) => localStorage.setItem("sandy.theme", theme), theme);
  await page.addInitScript((view) => {
    if (view && localStorage.getItem("sandy-sidebar:list-view:v1") === null)
      localStorage.setItem("sandy-sidebar:list-view:v1", view);
  }, listView);
  const railReserve = 49;
  await storeWidth(width + railReserve);
  await page.goto(fixture.url);
  const root = page.locator("[data-sandy-sidebar-root]");
  await expect(root).toBeVisible();
  const drift = width - Math.round((await root.boundingBox()).width);
  if (drift !== 0) {
    await storeWidth(width + railReserve + drift);
    await page.evaluate(() => {
      for (const key of Object.keys(sessionStorage))
        if (key.includes("sandy.sidebar.width")) sessionStorage.removeItem(key);
    });
    await page.reload();
    await expect(root).toBeVisible();
  }
  if (empty) {
    await expect(page.getByText("All clear. Time to touch some grass.")).toBeVisible();
  } else if (listView === "flow") {
    await expect(shelf(page, "Waiting")).toBeVisible();
  } else {
    await expect(page.getByRole("radiogroup", { name: "List layout" })).toBeVisible();
  }
}

export async function showArchived(page) {
  await page.getByRole("button", { name: /^View options:/ }).click();
  const sheet = page.getByRole("dialog", { name: "View options", exact: true });
  const checkbox = sheet.getByLabel("Show archived", { exact: true });
  if (!(await checkbox.isChecked())) await sheet.getByText("Show archived", { exact: true }).click();
  await expect(checkbox).toBeChecked();
  await page.keyboard.press("Escape");
}
