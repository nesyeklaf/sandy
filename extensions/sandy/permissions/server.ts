// sandy-plugin-permissions: choose pi's permission mode and its command blocklist
// in sandy. The settings are the source of truth; the host entry writes them into
// pi's ~/.pi/agent/permissions.json, which pi re-reads on every tool call.
import { PluginCliError, cliCommand, defineCli, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { hostContract, MODES, rpcContract, type Policy } from "./contract.ts";

export { rpcContract };

const CHANGED = "changed";
import { formatList, parseList } from "./lists.ts";

const DEFAULT_PROGRAMS = ["ssh", "scp", "sftp", "rsync", "sshfs", "ssh-copy-id", "mosh", "autossh"];
const DEFAULT_ALLOW = ["ssh AI"];

export default async function plugin(sandy: SandyPluginApi) {
  const settings = sandy.settings.define({
    mode: {
      type: "select",
      label: "pi permission mode",
      options: [...MODES],
      experimental_optionLabels: {
        ask: "ask: confirm and ask rules prompt",
        auto: "auto: only confirm rules prompt (default)",
        yolo: "yolo: no prompts, no read-only (blocked commands stay blocked)",
      },
      default: "auto",
    },
    readOnly: { type: "boolean", label: "Read-only override (no file changes)", default: false },
    blockedPrograms: {
      type: "string",
      label: "Blocked programs (one per line)",
      experimental_multiline: true,
      default: formatList(DEFAULT_PROGRAMS),
    },
    allowedRules: {
      type: "string",
      label: "Allowed exceptions (one per line, e.g. ssh AI)",
      experimental_multiline: true,
      default: formatList(DEFAULT_ALLOW),
    },
  });

  const host = sandy.hosts.experimental_client({ contract: hostContract });

  async function hostId(): Promise<string> {
    const id = (await sandy.sdk.system.config()).primaryHostId;
    if (!id) throw new Error("this server has no enrolled local host");
    return id;
  }

  async function policy(): Promise<Policy> {
    const v = await settings.get();
    return {
      mode: v.mode as Policy["mode"],
      readOnly: v.readOnly,
      programs: parseList(v.blockedPrograms),
      allow: parseList(v.allowedRules),
    };
  }

  /** Pushes the settings to pi's config file on the host; failures are logged, never thrown into settings saves. */
  async function sync(): Promise<string> {
    const { path } = await host.call("apply", await policy(), { hostId: await hostId() });
    return path;
  }
  const syncLogged = () => sync().then(
    (path) => sandy.log.info(`permissions written to ${path}`),
    (error) => sandy.log.warn(`permissions not written: ${String(error)}`),
  );

  settings.onChange(() => {
    sandy.realtime.publish(CHANGED, {});
    void syncLogged();
  });
  void syncLogged();

  sandy.rpc.register(rpcContract, {
    state: async () => policy(),
    async setMode({ mode }) {
      await settings.experimental_set({ mode });
      await sync();
      return policy();
    },
    async setReadOnly({ readOnly }) {
      await settings.experimental_set({ readOnly });
      await sync();
      return policy();
    },
  });

  const fail = (message: string, hint?: string) => new PluginCliError(message, { code: "permissions_error", hint });

  async function edit(key: "blockedPrograms" | "allowedRules", change: (list: string[]) => string[]) {
    const list = parseList((await settings.get())[key]);
    await settings.experimental_set({ [key]: formatList(change(list)) });
    return sync().catch((error) => { throw fail(String(error)); });
  }
  const entry = { name: "entry", description: "Program name, or an exception such as 'ssh AI'", required: true };

  sandy.cli.register(
    defineCli({
      name: "permissions",
      summary: "pi permission mode and command blocklist",
      commands: {
        status: cliCommand({
          summary: "Show settings and what pi's config file contains",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const wanted = await policy();
            const actual = await host.call("read", {}, { hostId: await hostId() }).catch((error) => { throw fail(String(error)); });
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ wanted, actual }, null, 2) };
            const inSync = actual.mode === wanted.mode && actual.readOnly === wanted.readOnly
              && JSON.stringify(actual.programs) === JSON.stringify(wanted.programs)
              && JSON.stringify(actual.allow) === JSON.stringify(wanted.allow);
            return { exitCode: 0, stdout: [
              `mode: ${wanted.mode}${wanted.readOnly ? " + read-only" : ""}`,
              `blocked: ${wanted.programs.join(", ") || "none"}`,
              `allowed: ${wanted.allow.join(", ") || "none"}`,
              `file: ${actual.path} (${inSync ? "in sync" : "differs; run a command or save a setting to write it"})`,
            ].join("\n") };
          },
        }),
        mode: cliCommand({
          summary: "Set the pi permission mode",
          positionals: [{ name: "mode", description: MODES.join(" | "), required: true }],
          async run(input) {
            const mode = input.positionals.mode ?? "";
            if (!(MODES as readonly string[]).includes(mode)) throw fail(`unknown mode '${mode}'`, `Use one of: ${MODES.join(", ")}`);
            await settings.experimental_set({ mode });
            const path = await sync().catch((error) => { throw fail(String(error)); });
            return { exitCode: 0, stdout: `mode ${mode} written to ${path}` };
          },
        }),
        block: cliCommand({
          summary: "Block a program (e.g. ssh)",
          positionals: [entry],
          async run(input) {
            const program = (input.positionals.entry ?? "").trim();
            if (/\s/.test(program)) throw fail("a program is a single word", "Use 'sandy permissions allow \"ssh AI\"' for exceptions");
            await edit("blockedPrograms", (list) => [...new Set([...list, program])]);
            return { exitCode: 0, stdout: `blocked ${program}` };
          },
        }),
        unblock: cliCommand({
          summary: "Remove a program from the blocklist",
          positionals: [entry],
          async run(input) {
            const program = (input.positionals.entry ?? "").trim();
            await edit("blockedPrograms", (list) => list.filter((item) => item !== program));
            return { exitCode: 0, stdout: `unblocked ${program}` };
          },
        }),
        allow: cliCommand({
          summary: "Allow an exception to the blocklist",
          positionals: [entry],
          async run(input) {
            const rule = (input.positionals.entry ?? "").trim();
            await edit("allowedRules", (list) => [...new Set([...list, rule])]);
            return { exitCode: 0, stdout: `allowed ${rule}` };
          },
        }),
        disallow: cliCommand({
          summary: "Remove an exception",
          positionals: [entry],
          async run(input) {
            const rule = (input.positionals.entry ?? "").trim();
            await edit("allowedRules", (list) => list.filter((item) => item !== rule));
            return { exitCode: 0, stdout: `removed exception ${rule}` };
          },
        }),
      },
    }),
  );
}
