import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import delegate from "./delegate/host.ts";
import goals from "./goals/host.ts";
import { hostContract } from "./host-contract.ts";
import track from "./track/host.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { ...delegate.handlers, ...track.handlers, ...goals.handlers },
});
