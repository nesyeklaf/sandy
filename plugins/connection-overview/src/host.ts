import { experimental_defineHostEntry } from "@sandy-sdk/plugin-sdk/host";
import { randomUUID } from "node:crypto";
import { hostConnectionsContract } from "./contract.js";
import { nodeProcFs } from "./proc-fs.js";
import type { Sampler } from "./sampler.js";
import { startSamplingLoop } from "./sampling-loop.js";

let sampler: Sampler | null = null;
const generation = randomUUID();

export default experimental_defineHostEntry({
  contract: hostConnectionsContract,
  handlers: {
    sample(input, context) {
      if (process.platform !== "linux")
        return { supported: false as const, platform: process.platform };
      if (sampler === null) {
        const lease = context.experimental_retainWorker();
        context.lifecycle.signal.addEventListener(
          "abort",
          () => void lease.dispose(),
          { once: true },
        );
        sampler = startSamplingLoop({
          fs: nodeProcFs,
          rootPid: process.ppid,
          generation,
          signal: context.lifecycle.signal,
          onError: (error) => console.error("connection sampler", error),
        });
      }
      return { supported: true as const, ...sampler.read(input) };
    },
  },
});
