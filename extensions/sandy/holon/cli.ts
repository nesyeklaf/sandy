import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { cliCommand, defineCli, PluginCliError, type PluginCliRegistration } from "@sandy-sdk/plugin-sdk";
import type { HolonEngine } from "./engine.ts";
import { HolonError } from "./error.ts";
import type { CheckOutput, ConfirmedOutput, DriftOutput, EvidenceRecordedOutput, ViewOutput } from "./core/outputs.ts";
import { renderCheck, renderConfirmed, renderDrift, renderEvidenceRecorded, renderView } from "./render.ts";
import { resolveRoot } from "./root.ts";

const common = {
  json: { type: "boolean", description: "Print the JSON output instead of text" },
  root: { type: "string", description: "Directory with the holon files; defaults to the repository root" },
  now: { type: "string", description: "Evaluate at this ISO time instead of the clock" },
  commit: { type: "string", description: "Current commit instead of git rev-parse HEAD" },
} as const;

interface CommonOptions {
  json: boolean;
  root?: string | undefined;
  now?: string | undefined;
  commit?: string | undefined;
}

function rethrow(cause: unknown): never {
  if (cause instanceof HolonError) throw new PluginCliError(cause.message, { code: cause.code, ...(cause.hint === undefined ? {} : { hint: cause.hint }) });
  throw cause;
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

const FLAG_FORM = ["replace", "holon", "side", "kind", "source", "result", "contract-hash", "build", "environment", "at", "expires", "detail"] as const;

function unsupported(option: string): never {
  throw new PluginCliError(`--${option} has no equivalent in holon serve yet`, {
    code: "unsupported_option",
    hint: "Record complete evidence records with --file or --jsonl, or run the holon CLI for this option",
  });
}

function readEvidenceFile(file: string, base: string): string {
  const path = isAbsolute(file) ? file : resolve(base, file);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new HolonError(`cannot read ${file}`, "file_not_found");
  }
}

export function holonCli(engine: HolonEngine): PluginCliRegistration {
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (cause) {
      rethrow(cause);
    }
  };
  const readQuery = (options: CommonOptions) => ({ now: options.now, commit: options.commit });

  return defineCli({
    name: "holon",
    summary: "Check holon files, list drift, view a holon, and record evidence and confirmations",
    description:
      "Holons are holon/v0 files in Git. Every command reads them under --root (default: the repository root) and evaluates at --now and --commit, through a holon serve process per root. Needs the holon binary on PATH or HOLON_BIN.",
    commands: {
      check: cliCommand({
        summary: "Validate every holon and confirmation file (holon-check/v0); exits 1 on errors",
        options: common,
        async run(input, ctx) {
          return guarded(async () => {
            const options = input.options;
            const reply = await engine.call(resolveRoot(options.root, ctx.cwd), { method: "GET", path: "/v0/check", query: readQuery(options) });
            const stdout = options.json ? withNewline(reply.text) : renderCheck(JSON.parse(reply.text) as CheckOutput);
            return { exitCode: reply.status === 200 ? 0 : 1, stdout };
          });
        },
      }),
      drift: cliCommand({
        summary: "List every drift sorted by holon then kind (holon-drift/v0)",
        options: common,
        async run(input, ctx) {
          return guarded(async () => {
            const options = input.options;
            const reply = await engine.call(resolveRoot(options.root, ctx.cwd), { method: "GET", path: "/v0/drift", query: readQuery(options) });
            return { exitCode: 0, stdout: options.json ? withNewline(reply.text) : renderDrift(JSON.parse(reply.text) as DriftOutput) };
          });
        },
      }),
      view: cliCommand({
        summary: "Show one holon with its parent, parts, seams and sides (holon-view/v0)",
        options: common,
        positionals: [{ name: "slug", description: "Holon id", required: true }],
        async run(input, ctx) {
          return guarded(async () => {
            const options = input.options;
            const path = `/v0/holons/${encodeURIComponent(input.positionals.slug)}`;
            const reply = await engine.call(resolveRoot(options.root, ctx.cwd), { method: "GET", path, query: readQuery(options) });
            return { exitCode: 0, stdout: options.json ? withNewline(reply.text) : renderView(JSON.parse(reply.text) as ViewOutput) };
          });
        },
      }),
      "evidence record": cliCommand({
        summary: "Record machine evidence runs from a JSONL file or text",
        description:
          "--file and --jsonl take one complete evidence record per line, as in fixtures/shop/evidence.jsonl. Recording one run from flags (--holon, --side, --result and the optional --kind, --source, --contract-hash, --build, --environment, --at, --expires, --detail) and --replace need a holon serve route that does not exist yet and fail with unsupported_option.",
        options: {
          ...common,
          file: { type: "string", description: "JSONL file with one evidence record per line" },
          jsonl: { type: "string", stdin: true, description: "JSONL evidence records as text" },
          replace: { type: "boolean", description: "Replace all evidence of this root instead of adding to it (not supported by holon serve yet)" },
          holon: { type: "string", description: "Holon id (not supported by holon serve yet)" },
          side: { type: "string", description: "I, It, We, They or seam:<to>" },
          kind: { type: "enum", values: ["ci", "metric", "alert", "file", "ticket", "formal"], description: "Machine proof kind" },
          source: { type: "string", description: "What ran: a test file, a metric, a ticket" },
          result: { type: "enum", values: ["pass", "fail"], description: "Outcome of the run" },
          "contract-hash": { type: "string", description: "sha256:<hex> of the contract checked against" },
          build: { type: "string", description: "Commit sha the run checked" },
          environment: { type: "string", description: "Where it ran; default local" },
          at: { type: "string", description: "ISO time of the run" },
          expires: { type: "string", description: "ISO time the evidence stops counting" },
          detail: { type: "string", description: "One line about the run" },
        },
        constraints: [
          { kind: "exactly-one", options: ["file", "jsonl", "holon"] },
          { kind: "requires", option: "holon", needs: ["side", "result"] },
        ],
        async run(input, ctx) {
          return guarded(async () => {
            const options = input.options;
            for (const name of FLAG_FORM) if (options[name] !== undefined && options[name] !== false) unsupported(name);
            const root = resolveRoot(options.root, ctx.cwd);
            const text = options.file !== undefined ? readEvidenceFile(options.file, ctx.cwd ?? root) : options.jsonl!;
            const reply = await engine.call(root, { method: "POST", path: "/v0/evidence", query: readQuery(options), contentType: "application/x-ndjson", body: text });
            return { exitCode: 0, stdout: options.json ? withNewline(reply.text) : renderEvidenceRecorded(JSON.parse(reply.text) as EvidenceRecordedOutput, root) };
          });
        },
      }),
      confirm: cliCommand({
        summary: "Write a human confirmation file under .holons/confirmations",
        description:
          "Writes .holons/confirmations/<slug>/<yyyy-mm-dd>-<side>-<by>.json, every : in the name as _, against the holon's current contract. Expires after the proof's every, at most 90 days.",
        options: {
          ...common,
          side: { type: "string", required: true, description: "I, It, We, They or seam:<to>" },
          by: { type: "string", required: true, description: "Who confirmed: a who-tree slug or agent:<name>" },
          "recorded-by": { type: "string", description: "Who wrote it down; defaults to --by" },
          answer: { type: "string", required: true, stdin: true, description: "The answer in the confirmer's words" },
          hesitation: { type: "string", repeatable: true, description: "A doubt the confirmer voiced; repeatable" },
          result: { type: "enum", values: ["confirmed", "refuted"], default: "confirmed", description: "confirmed or refuted" },
          at: { type: "string", description: "Date yyyy-mm-dd; defaults to the date of --now" },
          expires: { type: "string", description: "Date yyyy-mm-dd, at most 90 days after --at" },
        },
        positionals: [{ name: "slug", description: "Holon id", required: true }],
        async run(input, ctx) {
          return guarded(async () => {
            const options = input.options;
            const body = JSON.stringify({
              side: options.side,
              by: options.by,
              recordedBy: options["recorded-by"],
              answer: options.answer,
              hesitation: options.hesitation,
              result: options.result,
              at: options.at,
              expires: options.expires,
              now: options.now,
              commit: options.commit,
            });
            const path = `/v0/holons/${encodeURIComponent(input.positionals.slug)}/confirmations`;
            const reply = await engine.call(resolveRoot(options.root, ctx.cwd), { method: "POST", path, contentType: "application/json", body });
            return { exitCode: 0, stdout: options.json ? withNewline(reply.text) : renderConfirmed(JSON.parse(reply.text) as ConfirmedOutput) };
          });
        },
      }),
    },
  });
}
