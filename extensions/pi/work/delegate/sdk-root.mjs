// Where the pi SDK under test lives: PI_SDK_ROOT, else pi's managed install (<agent dir>/install, the
// release named in current-version), else the global install next to this node binary, else npm's global
// prefix (node from a version manager lives outside it).
// Tests run against the installed SDK on purpose: that is the code pi loads the extension into.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const entryIn = (root) => join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const nextToNode = join(dirname(process.execPath), "..", "lib");
const npmGlobal = () => join(execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(), "lib");

const managed = () => {
  const install = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "install");
  try {
    const root = join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim());
    return existsSync(entryIn(root)) ? root : undefined;
  } catch {
    return undefined;
  }
};
export const sdkRoot = resolve(process.env.PI_SDK_ROOT ?? managed() ?? (existsSync(entryIn(nextToNode)) ? nextToNode : npmGlobal()));
export const sdkEntry = entryIn(sdkRoot);
// pi-ai sits under pi-coding-agent in an npm global install and next to it in pi's own release install.
const nestedPiAi = join(sdkRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js");
export const piAiEntry = existsSync(nestedPiAi) ? nestedPiAi : join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js");
