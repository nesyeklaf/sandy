import { execFile } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { scratchHome } from "./isolation.mjs";

export async function createScratchKeychain(env) {
  if (process.platform !== "darwin") return null;
  if (!env.SANDY_DATA_DIR?.startsWith("/tmp/sandy-sidebar-smoke-")) {
    throw new Error("Keychain setup requires a scratch data directory");
  }
  scratchHome(env.HOME, env.SANDY_DATA_DIR);
  const keychains = join(env.HOME, "Library/Keychains");
  mkdirSync(keychains, { recursive: true });
  mkdirSync(join(env.HOME, "Library/Preferences"), { recursive: true });
  // Creating directly as login.keychain-db can fail to unlock on macOS.
  // Create a named keychain and keep the login alias inside the scratch home.
  const keychain = join(keychains, "sandy-sidebar.keychain-db");
  const security = async (args) => promisify(execFile)("/usr/bin/security", args, { env, timeout: 10_000 });
  await security(["create-keychain", "-p", "", keychain]);
  await security(["unlock-keychain", "-p", "", keychain]);
  await security(["set-keychain-settings", keychain]);
  symlinkSync("sandy-sidebar.keychain-db", join(keychains, "login.keychain-db"));
  await security(["list-keychains", "-d", "user", "-s", keychain]);
  await security(["default-keychain", "-d", "user", "-s", keychain]);
  // macOS disables the login-keychain setter. Login lookup uses this filename.
  const canonical = realpathSync(keychain);
  for (const args of [["default-keychain"], ["list-keychains", "-d", "user"], ["login-keychain"]]) {
    const { stdout } = await security(args);
    if (stdout.trim() !== `"${canonical}"`) throw new Error(`Scratch ${args[0]} did not resolve to ${canonical}`);
  }
  return canonical;
}
