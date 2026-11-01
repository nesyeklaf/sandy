import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import { agentDir, goalLink, snapshot } from "./agent.ts";
import { hostContract } from "./contract.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    read: async (input) => snapshot(agentDir(), input),
    goalLink: async (input) => goalLink(agentDir(), input),
  },
});
