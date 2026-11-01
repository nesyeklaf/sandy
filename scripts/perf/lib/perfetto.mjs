import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SQL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sql",
);

export const writeTrace = (path, events) =>
  new Promise((resolve, reject) => {
    const stream = createWriteStream(path);
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.write('{"traceEvents":[');
    events.forEach((event, index) => {
      stream.write((index === 0 ? "" : ",\n") + JSON.stringify(event));
    });
    stream.end("]}\n");
  });

export const traceProcessor = () => {
  const explicit = process.env.SANDY_PERF_TRACE_PROCESSOR;
  if (explicit) {
    if (!existsSync(explicit))
      throw new Error(
        "SANDY_PERF_TRACE_PROCESSOR points to a missing file: " + explicit,
      );
    return explicit;
  }
  const found = spawnSync(
    "sh",
    ["-c", "command -v trace_processor_shell || command -v trace_processor"],
    {
      encoding: "utf8",
    },
  );
  const path = found.stdout.trim();
  if (!path)
    throw new Error(
      "No Perfetto trace processor. Download it with: curl -LO https://get.perfetto.dev/trace_processor && chmod +x trace_processor, then set SANDY_PERF_TRACE_PROCESSOR to its path.",
    );
  return path;
};

const parseCsvLine = (line) => {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
};

const cellValue = (cell) => {
  if (cell === "[NULL]" || cell === "") return null;
  const number = Number(cell);
  return Number.isFinite(number) ? number : cell;
};

export const querySqlFile = (
  tracePath,
  sqlName,
  { windowGlob = null } = {},
) => {
  const sqlPath = sqlName.includes("/") ? sqlName : join(SQL_DIR, sqlName);
  const sql = readFileSync(sqlPath, "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "sandy-perf-sql-"));
  const queryPath = join(scratch, "query.sql");
  writeFileSync(
    queryPath,
    windowGlob === null
      ? sql
      : sql.replaceAll("'lab:*'", "'" + windowGlob.replaceAll("'", "''") + "'"),
  );
  const result = spawnSync(
    traceProcessor(),
    ["--query-file", queryPath, tracePath],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  rmSync(scratch, { recursive: true, force: true });
  if (result.status !== 0)
    throw new Error(
      "trace processor failed (" +
        result.status +
        "): " +
        result.stderr.slice(-2000),
    );
  const all = result.stdout.split("\n");
  const headerIndex = all.findIndex((line) => line.startsWith('"'));
  if (headerIndex === -1) return [];
  const lines = all.slice(headerIndex).filter((line) => line.trim() !== "");
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(
      header.map((name, index) => [name, cellValue(cells[index] ?? "")]),
    );
  });
};
