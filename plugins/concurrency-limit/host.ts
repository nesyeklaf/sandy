import { availableParallelism } from "node:os";
import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import { concurrencyLimitHostContract } from "./contract.js";

export default experimental_defineHostEntry({
  contract: concurrencyLimitHostContract,
  handlers: {
    getCapacity() {
      return { availableParallelism: availableParallelism() };
    },
  },
});
