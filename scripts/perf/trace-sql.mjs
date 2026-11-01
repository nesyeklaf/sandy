import { parseArgs } from "node:util";
import { querySqlFile } from "./lib/perfetto.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sql: { type: "string", default: "interaction-breakdown.sql" },
    windows: { type: "string", default: "sandy:*" },
    json: { type: "boolean", default: false },
  },
});
if (positionals.length !== 1) {
  console.log(`Usage: node scripts/perf/trace-sql.mjs <trace.json> [--sql <file in scripts/perf/sql or a path>] [--windows <glob>] [--json]

Runs a Perfetto SQL query on a Chrome trace, for example one saved from the DevTools Performance panel.
--windows picks the slices the breakdown splits up: sandy:* for the app's spans (default), sandy:switch for thread switches only, lab:* for the A/B runner's waits.`);
  process.exit(2);
}
const rows = querySqlFile(positionals[0], values.sql, {
  windowGlob: values.windows,
});
if (values.json) console.log(JSON.stringify(rows, null, 2));
else console.table(rows);
