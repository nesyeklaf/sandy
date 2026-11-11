import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sdk = createRequire(realpathSync(fileURLToPath(new URL("./node_modules/@sandy-sdk/plugin-sdk/package.json", import.meta.url))));
const shared = (name: string) => dirname(sdk.resolve(`${name}/package.json`));

export default defineConfig({
  resolve: { alias: { react: shared("react"), "react-dom": shared("react-dom") } },
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 30000,
    execArgv: Number(process.versions.node.split(".")[0]) >= 25 ? ["--no-webstorage"] : [],
    globalSetup: ["./test/global-setup.ts"],
    server: { deps: { inline: [/@testing-library\//] } },
  },
});
