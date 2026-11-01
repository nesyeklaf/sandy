import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { connectionOverviewContract } from "./contract.js";
import type { SourceHealth } from "./coverage.js";
import {
  OVERVIEW_ROW_LIMIT,
  attentionOrder,
  buildStatusReport,
} from "./report.js";
import { parseSince } from "./since.js";
import type { Store } from "./store.js";

export function registerOverviewRpc(
  sandy: SandyPluginApi,
  deps: { store: Store; health: () => SourceHealth[]; now?: () => number },
) {
  const now = deps.now ?? Date.now;
  sandy.rpc.register(connectionOverviewContract, {
    "overview.get": ({ window }) => {
      const current = now();
      const since = parseSince(window, current);
      const rows = deps.store.list({ since });
      const report = buildStatusReport(
        {
          rows,
          sources: deps.health(),
          gaps: deps.store.gaps(since),
          capReached: deps.store.capReached(),
        },
        since,
      );
      return {
        ...report,
        now: current,
        totalRows: rows.length,
        rows: attentionOrder(rows).slice(0, OVERVIEW_ROW_LIMIT),
      };
    },
  });
}
