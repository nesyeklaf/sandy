import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, defaultSidebarSettings } from "./test-inbox";

const sections = [
  { id: "sec_a", name: "Launch", createdAt: 0, updatedAt: 0 },
  { id: "sec_b", name: "Plan", createdAt: 1, updatedAt: 1 },
];
const projects = [
  { id: "proj_1", name: "Alpha", isPersonal: false, href: "/p1", settingsHref: "/p1/s" },
  { id: "proj_2", name: "Beta", isPersonal: false, href: "/p2", settingsHref: "/p2/s" },
];
const environment = (id: string) => ({
  id,
  name: "Worktree",
  branchName: `sandy/${id}`,
  workspaceDisplayKind: "managed-worktree" as const,
  path: null,
  isWorktree: null,
  providerId: null,
});
const openPr = {
  outcome: "available",
  pullRequest: {
    number: 7,
    title: "A PR",
    url: "https://github.com/o/r/pull/7",
    state: "open",
    attention: "none",
    updatedAt: "2026-10-31T00:00:00Z",
  },
};

export function setup({
  threads,
  settings = {},
  sdk = {},
  storage = {},
  sessionStore = {},
  lifecycleRows = () => [],
  pullRequests,
}: {
  threads: ReturnType<typeof thread>[];
  settings?: Record<string, unknown>;
  sdk?: Record<string, unknown>;
  storage?: Record<string, string>;
  sessionStore?: Record<string, string>;
  lifecycleRows?: () => unknown[];
  pullRequests?: (input: { keys: string[] }) => Record<string, unknown>;
}) {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem("sandy-sidebar:list-view:v1", "spaces");
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(sessionStore)) window.sessionStorage.setItem(key, value);
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects, sections },
    rpc: {
      listLifecycle: () => ({ rows: lifecycleRows() }),
      getSidebarSettings: () => ({ ...defaultSidebarSettings, ...settings }),
      pullRequests: (input) => {
        const { keys } = input as { keys: string[] };
        return (
          pullRequests?.({ keys }) ??
          Object.fromEntries(keys.map((key) => [key, key.startsWith("pr_") ? openPr : { outcome: "absent" }]))
        );
      },
    },
    sdk: sdk as never,
  });
}

export const recent = () => ({ updatedAt: Date.now(), latestAttentionAt: Date.now() });
export const prThreads = () => [
  thread({
    id: "ask",
    title: "Asks and PR",
    projectId: "proj_1",
    sectionId: "sec_a",
    hasPendingInteraction: true,
    environment: environment("pr_1"),
    ...recent(),
  }),
  thread({
    id: "busy",
    title: "Works and PR",
    projectId: "proj_2",
    sectionId: "sec_a",
    indicator: "runtime",
    environment: environment("pr_2"),
    ...recent(),
  }),
  thread({ id: "calm", title: "Calm one", projectId: "proj_1", sectionId: "sec_a", ...recent() }),
  thread({ id: "other", title: "Other Space", projectId: "proj_1", sectionId: "sec_b", ...recent() }),
];
