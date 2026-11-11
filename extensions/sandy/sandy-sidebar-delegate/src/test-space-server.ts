import { createFakePluginHost, makeThreadResponse } from "@sandy-sdk/plugin-sdk/testing";
import plugin from "./server";
import { disposers } from "./test-server";

export type FakeThread = ReturnType<typeof makeThreadResponse>;

export interface SpaceWorld {
  threads: FakeThread[];
  sections: Array<{ id: string; name: string }>;
}

export function spaceThread(id: string, sectionId: string | null, overrides: Partial<FakeThread> = {}): FakeThread {
  return {
    ...makeThreadResponse({ id, sectionId, title: id }),
    hasPendingInteraction: false,
    ...overrides,
  } as FakeThread;
}

export async function loadSpacePlugin(world: SpaceWorld, sdkOverrides: Record<string, unknown> = {}) {
  const { sandy, harness } = createFakePluginHost({
    pluginId: "sandy-sidebar",
    sdk: {
      projects: { list: async () => [] },
      threadSections: {
        list: async () => world.sections.map((section) => ({ ...section, createdAt: 1, updatedAt: 1, sortIndex: 0 })),
      },
      threads: {
        list: async (args: { threadIds?: string[]; archived?: boolean; sectionId?: string }) => {
          const requested = args?.threadIds;
          const wantsArchived = args?.archived === true;
          return world.threads.filter((thread) => {
            const archived = thread.archivedAt !== null;
            if (archived !== wantsArchived) return false;
            if (requested !== undefined && !requested.includes(thread.id)) return false;
            if (args?.sectionId !== undefined && thread.sectionId !== args.sectionId) return false;
            return true;
          });
        },
        ...(sdkOverrides as object),
      },
    },
  } as never);
  await plugin(sandy);
  disposers.push(() => harness.lifecycle.dispose());
  return Object.assign(harness, { sidebarDb: sandy.storage.database() });
}
