import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import { hostContract } from "./host-contract.ts";
import { branchChanges, mergeBranch } from "./host-git.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    branchChanges: async ({ path, branch }) => branchChanges(path, branch),
    mergeBranch: async ({ path, branch, message }) => mergeBranch(path, branch, message),
  },
});
