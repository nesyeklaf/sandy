import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createConnection,
  migrate,
  noopNotifier,
  upsertHost,
} from "../src/index.js";

it("moves hosts off the removed connect access provider and leaves others alone", () => {
  const directory = mkdtempSync(join(tmpdir(), "sandy-retire-connect-"));
  const db = createConnection(join(directory, "sandy.db"));
  try {
    migrate(db);
    for (const id of [
      "connect-host",
      "direct-host",
      "plugin-host",
      "unset-host",
    ])
      upsertHost(db, noopNotifier, { id, name: id });
    const setAccess = db.$client.prepare(
      "UPDATE hosts SET server_access_provider_id = ?, server_access_grant_id = ? WHERE id = ?",
    );
    setAccess.run("connect", "gate-grant-7", "connect-host");
    setAccess.run("direct", "direct-host", "direct-host");
    setAccess.run("tailscale", "ts-grant-1", "plugin-host");
    const before = db.$client.prepare("SELECT * FROM hosts ORDER BY id").all();
    const sql = readFileSync(
      new URL(
        "../drizzle/0149_retire_connect_server_access.sql",
        import.meta.url,
      ),
      "utf8",
    );
    db.$client.exec(sql);
    const after = db.$client.prepare("SELECT * FROM hosts ORDER BY id").all();
    expect(after).toEqual(
      before.map((row) => {
        const parsed = hostRow(row);
        return parsed.id === "connect-host"
          ? {
              ...parsed,
              server_access_provider_id: "direct",
              server_access_grant_id: "connect-host",
            }
          : row;
      }),
    );
    db.$client.exec(sql);
    expect(db.$client.prepare("SELECT * FROM hosts ORDER BY id").all()).toEqual(
      after,
    );
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function hostRow(value: unknown): Record<string, unknown> & { id: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  )
    throw new Error("Invalid host row");
  return { ...value, id: value.id };
}
