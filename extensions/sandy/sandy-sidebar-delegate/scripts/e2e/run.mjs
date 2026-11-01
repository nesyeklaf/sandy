import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startScratchServer } from "./server.mjs";

const started = performance.now();
const server = await startScratchServer();
try {
  const threads = [await server.seed("Atlas planning", { idle: true })];
  for (const title of ["Birch implementation", "Cedar review", "Delta follow-up"]) {
    threads.push(await server.seed(title, { idle: true }));
  }
  await server.checkIsolation("seeded");
  const settingsResponse = await fetch(`${server.url}/api/v1/plugins/sandy-sidebar/rpc/getSidebarSettings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const settingsPayload = await settingsResponse.json();
  if (!settingsResponse.ok || !settingsPayload.ok) throw new Error("Cannot read scratch fixture settings");
  const fixturePath = join(server.scratch, "fixture.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      url: server.url,
      env: server.env,
      sandy: server.sandy,
      threads,
      projectId: server.projectId,
      defaultSettings: settingsPayload.result,
    }),
  );
  const args = process.argv.slice(2);
  const appIndex = args.indexOf("--app-dir");
  if (appIndex >= 0) args.splice(appIndex, 2);
  const result = await server.run(
    process.execPath,
    [resolve("node_modules/@playwright/test/cli.js"), "test", "--config", "e2e/playwright.config.mjs", ...args],
    { allowFailure: true, timeoutMs: 600_000, stream: true, env: { ...server.toolEnv, E2E_FIXTURE: fixturePath } },
  );
  await server.checkIsolation("complete");
  process.exitCode = result.code ?? 1;
  if (process.exitCode !== 0) await server.diagnostics();
} catch (error) {
  await server.diagnostics();
  throw error;
} finally {
  await server.cleanup();
  console.log(`E2E elapsed: ${((performance.now() - started) / 1000).toFixed(2)}s`);
}
