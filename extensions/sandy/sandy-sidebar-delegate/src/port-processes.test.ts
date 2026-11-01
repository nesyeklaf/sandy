import { describe, expect, it } from "vitest";
import { isSandyInternalListener, parseProcessCommands } from "./port-processes";

describe("SANDY internal port filtering", () => {
  it.each([
    [
      "sandy Nightly",
      "/Applications/sandy Nightly.app/Contents/MacOS/sandy Nightly /Applications/sandy Nightly.app/Contents/Resources/app.asar.unpacked/node_modules/sandy-app/host-daemon/dist/sandy-provider-bridge-worker.mjs",
    ],
    ["node", "/usr/bin/node /opt/node_modules/sandy-app/server/dist/index.js"],
    ["sandy", "/usr/bin/sandy"],
    ["sandy Nightly", ""],
  ])("excludes the SANDY runtime %s", (name, command) => {
    expect(isSandyInternalListener(name, command)).toBe(true);
  });

  it.each([
    ["git-history", "git-history"],
    ["node", "/usr/bin/node /workspace/server.js"],
    ["python3", "python3 -m http.server 49631"],
    ["sandy-api", "sandy-api"],
    ["sandy Nightly", "/Applications/sandy Nightly.app/Contents/MacOS/sandy Nightly /workspace/server.js"],
  ])("keeps the user server %s", (name, command) => {
    expect(isSandyInternalListener(name, command)).toBe(false);
  });

  it("reads commands containing spaces without losing the executable path", () => {
    expect(
      parseProcessCommands("  123 /Applications/sandy Nightly.app/Contents/MacOS/sandy Nightly\n  456 node server.js\n"),
    ).toEqual(
      new Map([
        [123, "/Applications/sandy Nightly.app/Contents/MacOS/sandy Nightly"],
        [456, "node server.js"],
      ]),
    );
  });
});
