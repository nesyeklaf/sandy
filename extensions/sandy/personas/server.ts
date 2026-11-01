// sandy-plugin-personas: per-thread persona and skill presets. The selection is
// stored per scope ("thread:<id>" or "new:<projectId>") and turned into an
// instruction block by sandy.agents.configure when a session is built.
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { rpcContract } from "./contract.ts";
import {
  assemble,
  BLOCK_LIMIT,
  cachedLibrary,
  DEFAULT_SKILL_ROOTS,
  EMPTY_SELECTION,
  expandHome,
  findSkillFile,
  seedIfMissing,
  type Selection,
} from "./presets.ts";

export { rpcContract };

const SELECTION_CHANGED = "selection-changed";

export default async function plugin(sandy: SandyPluginApi) {
  const settings = sandy.settings.define({
    presetsDir: { type: "string", label: "Preset folder", default: "~/.pi/agent/chat-presets" },
    skillRoots: {
      type: "string",
      label: "Skill folders (comma separated)",
      default: DEFAULT_SKILL_ROOTS.join(","),
    },
  });
  const values = await settings.get();
  const dir = expandHome(values.presetsDir);
  const skillRoots = values.skillRoots.split(",").map((root) => expandHome(root.trim())).filter((root) => root !== "");
  if (seedIfMissing(dir)) sandy.log.info(`seeded example presets in ${dir}`);
  const library = cachedLibrary(dir);
  const skillFile = (name: string) => findSkillFile(name, skillRoots);

  const readSelection = (scope: string) => sandy.storage.kv.get<Selection>(`sel:${scope}`);

  // configure() is synchronous and kv is async, so selections are mirrored in
  // memory. A new thread adopts the selection made in the new-thread composer
  // of its project, once.
  const mirror = new Map<string, Selection>();
  for (const key of await sandy.storage.kv.list("sel:")) {
    const value = await sandy.storage.kv.get<Selection>(key);
    if (value !== null && value !== undefined) mirror.set(key.slice("sel:".length), value);
  }

  sandy.rpc.register(rpcContract, {
    async state({ scope }) {
      const lib = library();
      const selection = (await readSelection(scope)) ?? EMPTY_SELECTION;
      const assembled = assemble(lib, selection, skillFile);
      const brief = (p: { id: string; name: string; icon: string; skill: string | null }) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        skill: p.skill,
      });
      return {
        dir,
        personas: lib.personas.map(brief),
        skills: lib.skills.map(brief),
        problems: lib.problems,
        selection,
        length: assembled.length,
        limit: BLOCK_LIMIT,
        warnings: assembled.warnings,
      };
    },
    async select({ scope, selection }) {
      const empty = selection.persona === null && selection.skills.length === 0;
      if (empty) {
        mirror.delete(scope);
        await sandy.storage.kv.delete(`sel:${scope}`);
      } else {
        mirror.set(scope, selection);
        await sandy.storage.kv.set(`sel:${scope}`, selection);
      }
      sandy.realtime.publish(SELECTION_CHANGED, { scope });
      return { ok: true };
    },
  });

  sandy.agents.configure((context) => {
    const own = `thread:${context.thread.id}`;
    let selection = mirror.get(own);
    if (selection === undefined) {
      const pendingKey = `new:${context.project.id}`;
      const pending = mirror.get(pendingKey);
      if (pending !== undefined) {
        selection = pending;
        mirror.delete(pendingKey);
        mirror.set(own, pending);
        void sandy.storage.kv.set(`sel:${own}`, pending);
        void sandy.storage.kv.delete(`sel:${pendingKey}`);
      }
    }
    if (selection === undefined) return { tools: [], skills: [] };
    const assembled = assemble(library(), selection, skillFile);
    for (const warning of assembled.warnings) sandy.log.warn(`${context.thread.id}: ${warning}`);
    return assembled.block === null
      ? { tools: [], skills: [] }
      : { tools: [], skills: [], instructions: assembled.block };
  });
}
