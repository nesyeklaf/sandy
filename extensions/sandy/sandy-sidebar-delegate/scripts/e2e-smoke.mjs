import { chromium } from "@playwright/test";
import { startScratchServer } from "./e2e/server.mjs";

const server = await startScratchServer();
let browser;
try {
  const thread = await server.seed("Sidebar smoke thread");
  browser = await chromium.launch({ env: server.toolEnv, args: ["--use-mock-keychain"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /\[plugin:sandy-sidebar\]|is not a function|ReferenceError|TypeError/.test(message.text())
    ) {
      errors.push(message.text());
    }
  });
  await page.goto(server.url);
  await page
    .getByRole("region", { name: "Active", exact: true })
    .getByRole("link", { name: thread.title, exact: true })
    .waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
  await server.checkIsolation("complete");
  console.log("PASS: sidebar renders the scratch thread without JavaScript errors");
} finally {
  await browser?.close();
  await server.cleanup();
}
