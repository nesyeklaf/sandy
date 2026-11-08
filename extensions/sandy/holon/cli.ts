import { cliCommand, defineCli, PluginCliError, type PluginCliRegistration } from "@sandy-sdk/plugin-sdk";
import { renderCheck, renderDrift, renderView } from "./render.ts";
import { HolonInputError, HolonService, resolveRoot, type EnvOptions } from "./service.ts";
import type { Evidence } from "./core/format.ts";

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
  if (cause instanceof HolonInputError) throw new PluginCliError(cause.message, { code: cause.code, ...(cause.hint === undefined ? {} : { hint: cause.hint }) });
  throw cause;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function holonCli(service: HolonService): PluginCliRegistration {
  const open = (options: CommonOptions, cwd: string | undefined) => {
    const root = resolveRoot(options.root, cwd);
    const env: EnvOptions = { now: options.now, commit: options.commit };
    return service.open(root, env);
  };
  const guarded = <T>(run: () => T): T => {
    try {
      return run();
    } catch (cause) {
      rethrow(cause);
    }
  };

  return defineCli({
    name: "holon",
    summary: "Check holon files, list drift, view a holon, and record evidence and confirmations",
    description:
      "Holons are holon/v0 files in Git. Every command reads them under --root (default: the repository root), evaluates at --now and --commit, and keeps an incremental index in the plugin database.",
    commands: {
      check: cliCommand({
        summary: "Validate every holon and confirmation file (holon-check/v0); exits 1 on errors",
        options: common,
        async run(input, ctx) {
          return guarded(() => {
            const { index } = open(input.options, ctx.cwd);
            const output = index.check();
            return { exitCode: output.errors.length === 0 ? 0 : 1, stdout: input.options.json ? json(output) : renderCheck(output) };
          });
        },
      }),
      drift: cliCommand({
        summary: "List every drift sorted by holon then kind (holon-drift/v0)",
        options: common,
        async run(input, ctx) {
          return guarded(() => {
            const { index } = open(input.options, ctx.cwd);
            const output = index.drift();
            return { exitCode: 0, stdout: input.options.json ? json(output) : renderDrift(output) };
          });
        },
      }),
      view: cliCommand({
        summary: "Show one holon with its parent, parts, seams and sides (holon-view/v0)",
        options: common,
        positionals: [{ name: "slug", description: "Holon id", required: true }],
        async run(input, ctx) {
          return guarded(() => {
            const { index } = open(input.options, ctx.cwd);
            service.holonFor(index, input.positionals.slug);
            const output = index.view(input.positionals.slug)!;
            return { exitCode: 0, stdout: input.options.json ? json(output) : renderView(output) };
          });
        },
      }),
      "evidence record": cliCommand({
        summary: "Record machine evidence runs, from flags or a JSONL file",
        description:
          "With flags, missing --kind, --source and --contract-hash come from the holon's declared proof and current contract, --build from --commit, --at from --now. --file and --jsonl take one evidence record per line, as in fixtures/shop/evidence.jsonl. --replace drops the evidence recorded before for this root.",
        options: {
          ...common,
          file: { type: "string", description: "JSONL file with one evidence record per line" },
          jsonl: { type: "string", stdin: true, description: "JSONL evidence records as text" },
          replace: { type: "boolean", description: "Replace all evidence of this root instead of adding to it" },
          holon: { type: "string", description: "Holon id" },
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
          return guarded(() => {
            const options = input.options;
            const { index, env } = open(options, ctx.cwd);
            let records: Evidence[];
            if (options.file !== undefined) records = service.readEvidenceFile(index.root, ctx.cwd, options.file);
            else if (options.jsonl !== undefined) records = service.parseEvidenceText(options.jsonl);
            else {
              records = [
                service.completeEvidence(index, env, {
                  holon: options.holon!,
                  side: options.side!,
                  kind: options.kind,
                  source: options.source,
                  result: options.result!,
                  contractHash: options["contract-hash"],
                  build: options.build,
                  environment: options.environment,
                  at: options.at,
                  expires: options.expires,
                  detail: options.detail,
                }),
              ];
            }
            const stats = options.replace ? index.replaceEvidence(records, env) : index.recordEvidence(records, env);
            const unknown = [...new Set(records.map((record) => record.holon).filter((id) => index.get(id) === null))].sort();
            const output = { format: "holon-evidence-recorded/v0", recorded: records.length, reevaluated: stats.evaluated, unknownHolons: unknown };
            const text = [
              `● recorded ${records.length} evidence record${records.length === 1 ? "" : "s"}, ${stats.evaluated} holons re-evaluated`,
              ...unknown.map((id) => `! no holon ${id} under ${index.root}; kept for when it appears`),
            ].join("\n");
            return { exitCode: 0, stdout: options.json ? json(output) : `${text}\n` };
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
          return guarded(() => {
            const options = input.options;
            const { index, env } = open(options, ctx.cwd);
            const { path, confirmation } = service.confirm(index, env, {
              holon: input.positionals.slug,
              side: options.side,
              by: options.by,
              recordedBy: options["recorded-by"],
              answer: options.answer,
              hesitation: options.hesitation,
              result: options.result as "confirmed" | "refuted",
              at: options.at,
              expires: options.expires,
            });
            const view = index.view(confirmation.holon)!;
            const light = confirmation.side.startsWith("seam:")
              ? view.seams.find((seam) => seam.from === confirmation.holon && `seam:${seam.to}` === confirmation.side)?.light ?? "open"
              : view.focus.sides[confirmation.side as "I"].light;
            const output = { format: "holon-confirmed/v0", path, confirmation, light };
            return { exitCode: 0, stdout: options.json ? json(output) : `● wrote ${path}; ${confirmation.side} is now ${light}\n` };
          });
        },
      }),
    },
  });
}
