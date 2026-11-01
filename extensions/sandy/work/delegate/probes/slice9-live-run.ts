// Slice 9 live run: sandy_delegate_status logic (server/status.ts + the statusHost adapter of server/sandy-host.ts) against real SANDY threads.
// The plugin SDK is only available inside the plugin host, so SandyHostApi is a shim over the `sandy` CLI:
// threads.get = sandy thread show, events.list = sandy thread log --json --all (filtered like SANDY's list), and
// defaultExecutionOptions is taken from the newest client/turn/requested event's execution block.
// Usage: node --experimental-strip-types probes/slice9-live-run.ts <parentId> <finishedId> <runningId> <failedId>
import { execFileSync } from "node:child_process";
import { openDb } from "../tests/db-fixture.ts";
import { admit, bindChild } from "../server/ledger.ts";
import { createSandyHosts, type SandyHostApi } from "../server/sandy-host.ts";
import { enrichDelegations, statusFor } from "../server/status.ts";
import { formatDelegationTable, listDelegations } from "../server/list.ts";

const sandyJson = (args: string[]): any => {
  try {
    return JSON.parse(execFileSync("sandy", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SANDY_THREAD_ID: "" } }));
  } catch (error) {
    throw Object.assign(new Error(String((error as Error).message)), { status: /not found/i.test(String((error as { stdout?: string }).stdout)) ? 404 : 500 });
  }
};
const logOf = (threadId: string): any[] => sandyJson(["thread", "log", threadId, "--json", "--all"]);

const sdk = {
  threads: {
    get: async ({ threadId }: { threadId: string }) => sandyJson(["thread", "show", threadId, "--json"]).thread,
    events: {
      list: async ({ threadId, types, order, limit, afterSeq }: { threadId: string; types?: string[]; order?: string; limit?: string; afterSeq?: string }) => {
        let rows = logOf(threadId).filter((event) => (types === undefined || types.includes(event.type)) && (afterSeq === undefined || event.seq > Number(afterSeq)));
        if (order === "desc") rows = rows.reverse();
        return limit === undefined ? rows : rows.slice(0, Number(limit));
      },
    },
    defaultExecutionOptions: async ({ threadId }: { threadId: string }) => {
      const requested = logOf(threadId).filter((event) => event.type === "client/turn/requested").at(-1);
      return requested?.data?.execution ?? null;
    },
  },
};
const { statusHost } = createSandyHosts({ pluginId: "delegate", sdk, storage: { kv: { get: async () => null } } } as unknown as SandyHostApi);

const [parent, finished, running, failed] = process.argv.slice(2);
const db = openDb();
for (const child of [finished, running, failed]) {
  const admitted = admit(db, { rootThreadId: parent, callerThreadId: parent, kind: "delegate", agent: "scout", inputHash: child }, { maxConcurrentChildren: 10 });
  if (!admitted.ok) throw new Error("admit refused");
  bindChild(db, admitted.delegation.delegationId, child, (await sdk.threads.get({ threadId: child })).createdAt + 1000);
}
const show = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const all = await statusFor(db, statusHost, parent);
console.log("## sandy_delegate_status() from the parent");
show(all);
if (all.ok) {
  console.log("## sandy_delegate_status({delegationId}) for the running child");
  show(await statusFor(db, statusHost, parent, all.delegations.find((row) => row.threadId === running)!.delegationId));
}
console.log("## foreign caller, unknown id, child caller");
const own = all.ok ? all.delegations[0].delegationId : "";
show(await statusFor(db, statusHost, "thr_somebody_else", own));
show(await statusFor(db, statusHost, parent, "dlg_unknown"));
show(await statusFor(db, statusHost, finished));
console.log("## sandy delegate list (table)");
console.log(formatDelegationTable(await enrichDelegations(db, statusHost, listDelegations(db, { limit: 10 }))));
