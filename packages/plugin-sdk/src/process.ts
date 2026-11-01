/** Host-local executable discovery and child environments shared with core. */
export { hostToolchain as experimental_hostToolchain } from "@sandy/process-utils";

/** Spawn with refreshed executable discovery, PATH, and Windows shim handling. */
export {
  spawnHostProcess as experimental_spawnHostProcess,
  forkHostProcess as experimental_forkHostProcess,
  execHostFile as experimental_execHostFile,
  execHostFileCallback as experimental_execHostFileCallback,
} from "@sandy/process-utils";
