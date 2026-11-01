import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import { agentDir, extensionFile, installExtension, requestReload, withHooks } from "./agent.ts";
import { hostContract } from "./contract.ts";
import { measure } from "./procscan.ts";
import { existsSync } from "node:fs";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: async () => {
      const agent = agentDir();
      return { extensionInstalled: existsSync(extensionFile(agent)), processes: withHooks(agent, await measure()) };
    },
    requestReload: async ({ targets }) => ({ requested: requestReload(agentDir(), targets) }),
    install: async () => ({ path: installExtension(agentDir()) }),
  },
});
