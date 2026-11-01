import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { incomingMoveDir, readIncomingMoveState } from "./move-state.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("readIncomingMoveState", () => {
  it("reads a state written before the bind host left server moves", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sandy-move-state-"));
    dirs.push(dataDir);
    const moveId = "move-legacy";
    await mkdir(incomingMoveDir(dataDir, moveId), { recursive: true });
    const state = {
      version: 1,
      moveId,
      activationToken: "activation-token-0123456789",
      serverPort: 38_886,
      importedEntries: null,
      archivedServerData: null,
      pendingServer: null,
      preparedAt: null,
      activation: null,
    };
    await writeFile(
      join(incomingMoveDir(dataDir, moveId), "state.json"),
      JSON.stringify({ ...state, bindHost: "0.0.0.0" }),
    );

    expect(await readIncomingMoveState(dataDir, moveId)).toEqual(state);
  });
});
