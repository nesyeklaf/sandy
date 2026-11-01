// One plugin, four parts. SANDY accepts some registrations once per plugin (agents.configure,
// agents.contributeInstructions, cli.register) and numbers storage migrations per database, so
// each part registers through a view of sandy that collects those calls; finish() registers them once.
import type { SandyPluginApi, PluginCliRegistration, PluginCliResult } from "@sandy-sdk/plugin-sdk";

type ConfigureProvider = Parameters<SandyPluginApi["agents"]["configure"]>[0];
type Configuration = ReturnType<ConfigureProvider>;
type ToolEntry = Configuration["tools"][number];
type InstructionProvider = Parameters<SandyPluginApi["agents"]["contributeInstructions"]>[0];
type Database = ReturnType<SandyPluginApi["storage"]["database"]>;

const toolName = (tool: ToolEntry): string => (typeof tool === "string" ? tool : tool.name);

/** Union of the parts' selections. A duplicate name would reject the whole selection, so the first
 * entry with parameters wins over a plain name. */
export function mergeConfigurations(configurations: Configuration[]): Configuration {
  const tools = new Map<string, ToolEntry>();
  for (const configuration of configurations) {
    for (const tool of configuration.tools) {
      const name = toolName(tool);
      const seen = tools.get(name);
      if (seen === undefined || (typeof seen === "string" && typeof tool !== "string")) tools.set(name, tool);
    }
  }
  const skills = [...new Set(configurations.flatMap((configuration) => configuration.skills))];
  const instructions = configurations.map((configuration) => configuration.instructions).filter((text): text is string => typeof text === "string" && text.length > 0);
  return { tools: [...tools.values()], skills, ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}) };
}

export interface CliPart {
  registration: PluginCliRegistration;
}

const HELP = new Set(["--help", "-h", "help"]);

/** `sandy <name> <part> …` hands `…` to the part's own registration. A part's CLI renders its help and
 * errors as `sandy <part> …`; the dispatch puts `<name>` in front there, so they name the command people type.
 * Successful output of a command (tables, JSON) passes untouched. */
export function dispatchCli(name: string, summary: string, parts: PluginCliRegistration[]): PluginCliRegistration {
  const byName = new Map(parts.map((part) => [part.name, part]));
  const overview = (): string =>
    [`sandy ${name}: ${summary}`, "", ...parts.map((part) => `  ${part.name.padEnd(16)} ${part.summary}`), "", `Run sandy ${name} <command> --help for its commands.`].join("\n") + "\n";
  return {
    name,
    summary,
    commands: parts.map((part) => ({ name: part.name, summary: part.summary, usage: `sandy ${name} ${part.name} <command> ...` })),
    rendersHelp: true,
    async run(argv, ctx): Promise<PluginCliResult> {
      const [first, ...rest] = argv;
      if (first === undefined || HELP.has(first)) return { exitCode: 0, stdout: overview() };
      const part = byName.get(first);
      if (part === undefined) return { exitCode: 2, stderr: `unknown command "${first}"\n\n${overview()}` };
      const help = rest.some((arg) => HELP.has(arg));
      if (!part.rendersHelp && help) {
        const lines = (part.commands ?? []).map((command) => `  ${command.usage}\n      ${command.summary}`);
        return { exitCode: 0, stdout: prefixCommand([`sandy ${part.name}: ${part.summary}`, "", ...lines].join("\n") + "\n", name, part.name) };
      }
      const result = await part.run(rest, ctx);
      const prefix = (text: string | undefined): string | undefined => (text === undefined ? undefined : prefixCommand(text, name, part.name));
      return { ...result, stderr: prefix(result.stderr), stdout: help || result.exitCode !== 0 ? prefix(result.stdout) : result.stdout };
    },
  };
}

/** `sandy <part>` becomes `sandy <name> <part>`; text that already says `sandy <name> <part>` stays as it is. */
export function prefixCommand(text: string, name: string, part: string): string {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\bsandy ${escaped}(?![\\w-])`, "g"), `sandy ${name} ${part}`);
}

export interface Combined {
  /** The sandy a part registers through. */
  view: SandyPluginApi;
  /** Registers what the parts collected. Call once, after every part. */
  finish(): void;
}

/** `migrations` is the one list for the plugin database. A part's own migrate call must pass one of
 * `partMigrations` (it was already applied as a slice of `migrations`); anything else throws. */
export function combine(sandy: SandyPluginApi, options: { cli: { name: string; summary: string }; migrations: string[]; partMigrations: string[][] }): Combined {
  const configures: ConfigureProvider[] = [];
  const instructions: InstructionProvider[] = [];
  const clis: PluginCliRegistration[] = [];
  let finished = false;
  let migrated = false;

  const migrateAll = (db: Database): void => {
    if (migrated) return;
    sandy.storage.migrate(db, options.migrations);
    migrated = true;
  };

  const agents = Object.assign(Object.create(sandy.agents) as SandyPluginApi["agents"], {
    configure(provider: ConfigureProvider) {
      if (finished) throw new Error("configure after finish");
      configures.push(provider);
    },
    contributeInstructions(provider: InstructionProvider) {
      if (finished) throw new Error("contributeInstructions after finish");
      instructions.push(provider);
    },
  });
  const cli = Object.assign(Object.create(sandy.cli) as SandyPluginApi["cli"], {
    register(registration: PluginCliRegistration) {
      if (finished) throw new Error("cli.register after finish");
      clis.push(registration);
    },
  });
  const storage = Object.assign(Object.create(sandy.storage) as SandyPluginApi["storage"], {
    migrate(db: Database, statements: string[]) {
      if (!options.partMigrations.includes(statements)) throw new Error("append the migration to the plugin's migration list instead of migrating a separate list");
      migrateAll(db);
    },
  });
  const view = Object.assign(Object.create(sandy) as SandyPluginApi, { agents, cli, storage });

  return {
    view,
    finish() {
      if (finished) return;
      finished = true;
      if (configures.length > 0) sandy.agents.configure((context) => mergeConfigurations(configures.map((provider) => provider(context))));
      if (instructions.length > 0) {
        sandy.agents.contributeInstructions((ctx) => {
          const texts = instructions.map((provider) => provider(ctx)).filter((text): text is string => typeof text === "string" && text.length > 0);
          return texts.length > 0 ? texts.join("\n\n") : null;
        });
      }
      if (clis.length > 0) sandy.cli.register(dispatchCli(options.cli.name, options.cli.summary, clis));
    },
  };
}
