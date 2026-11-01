import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import { applyPolicy, configPath, readPolicy } from "./apply.ts";
import { hostContract } from "./contract.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    apply: async (policy) => {
      const file = configPath();
      applyPolicy(file, policy);
      return { path: file };
    },
    read: async () => readPolicy(configPath()),
  },
});
