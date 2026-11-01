// sandy-plugin-fabric-render: shows a session's fabric_exec calls as cards. pi-fabric appends a bounded
// `fabric-render` entry per call; SANDY logs it as provider/unhandled (sdk/unknown, entry_appended). The plugin
// reads those rows through sandy.sdk.threads.events and joins them to the tool calls (see join.ts).
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { rpcContract } from "./contract.ts";
import { isRelevant, joinExecs, type Row } from "./join.ts";

export { rpcContract };

const PAGE = 100; // the server rejects larger pages
const MAX_PAGES = 200;

export default async function plugin(sandy: SandyPluginApi) {
  // Per thread: the relevant rows read so far and the last sequence seen, so a refresh reads only new events.
  const cache = new Map<string, { lastSeq: number; rows: Row[] }>();

  async function rowsOf(threadId: string): Promise<Row[]> {
    const state = cache.get(threadId) ?? { lastSeq: 0, rows: [] };
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await sandy.sdk.threads.events.list({
        threadId,
        afterSeq: String(state.lastSeq),
        limit: String(PAGE),
        order: "asc",
        types: ["item/started", "item/completed", "provider/unhandled"],
      });
      for (const row of batch) {
        const mapped: Row = { seq: row.seq, createdAt: row.createdAt, type: row.type, data: row.data };
        if (isRelevant(mapped)) state.rows.push(mapped);
        state.lastSeq = Math.max(state.lastSeq, row.seq);
      }
      if (batch.length < PAGE) break;
    }
    cache.set(threadId, state);
    return state.rows;
  }

  sandy.rpc.register(rpcContract, {
    execs: async ({ threadId, limit }) => {
      const execs = joinExecs(await rowsOf(threadId)).slice(-(limit ?? 50)).reverse();
      return { execs, withEntry: execs.filter((e) => e.source === "entry").length };
    },
  });
}
