import {
  createDesktopBrowsersArea,
  type ExperimentalDesktopBrowsersArea,
} from "./areas/desktop-browsers.js";
import type { SandySdkContext, SandySdkTransport } from "./transport.js";
import {
  createEnvironmentsArea,
  type EnvironmentsArea,
} from "./areas/environments.js";
import { createFilesArea, type FilesArea } from "./areas/files.js";
import type { GuideArea } from "./areas/guide.js";
import { createHostsArea, type HostsArea } from "./areas/hosts.js";
import {
  createServerArea,
  type ExperimentalServerArea,
} from "./areas/server.js";
import { createProjectsArea, type ProjectsArea } from "./areas/projects.js";
import { createProvidersArea, type ProvidersArea } from "./areas/providers.js";
import { createPluginsArea, type PluginsArea } from "./areas/plugins.js";
import {
  createPromptHistoryArea,
  type ExperimentalPromptHistoryArea,
} from "./areas/prompt-history.js";
import { createSandyRealtimeClient } from "./realtime-client.js";
import type { SandyRealtime } from "./realtime-types.js";
import { createStatusArea, type StatusArea } from "./areas/status.js";
import { createSkillsArea, type SkillsArea } from "./areas/skills.js";
import { createThemeArea, type ThemeArea } from "./areas/theme.js";
import { createSystemArea, type SystemArea } from "./areas/system.js";
import { createTerminalsArea, type TerminalsArea } from "./areas/terminals.js";
import { createThreadsArea, type ThreadsArea } from "./areas/threads.js";
import {
  createThreadSectionsArea,
  type ThreadSectionsArea,
} from "./areas/thread-sections.js";

export type * from "./public-types.js";
export { createBuiltinPlanCommandTextInput } from "@sandy/domain";

export interface CreateSandySdkArgs {
  context?: SandySdkContext;
  transport: SandySdkTransport;
}

export interface CreateSandySdkWithGuideArgs extends CreateSandySdkArgs {
  guide: GuideArea;
}

export interface SandySdkAreas extends SandyRealtime {
  experimental_desktopBrowsers: ExperimentalDesktopBrowsersArea;
  experimental_promptHistory: ExperimentalPromptHistoryArea;
  experimental_server: ExperimentalServerArea;
  environments: EnvironmentsArea;
  files: FilesArea;
  hosts: HostsArea;
  projects: ProjectsArea;
  plugins: PluginsArea;
  providers: ProvidersArea;
  skills: SkillsArea;
  status: StatusArea;
  system: SystemArea;
  terminals: TerminalsArea;
  theme: ThemeArea;
  threadSections: ThreadSectionsArea;
  threads: ThreadsArea;
}

export interface SandySdk extends SandySdkAreas {
  guide: GuideArea;
}

export function createSandySdk(args: CreateSandySdkWithGuideArgs): SandySdk;
export function createSandySdk(args: CreateSandySdkArgs): SandySdkAreas;
export function createSandySdk(
  args: CreateSandySdkArgs | CreateSandySdkWithGuideArgs,
): SandySdkAreas | SandySdk {
  const sdkContext = { transport: args.transport };
  const realtime = createSandyRealtimeClient({
    transport: args.transport,
  });
  const areas: SandySdkAreas = {
    experimental_desktopBrowsers: createDesktopBrowsersArea(sdkContext),
    experimental_promptHistory: createPromptHistoryArea(sdkContext),
    experimental_server: createServerArea(sdkContext),
    environments: createEnvironmentsArea(sdkContext),
    files: createFilesArea(sdkContext),
    hosts: createHostsArea(sdkContext),
    subscribe(args) {
      return realtime.subscribe(args);
    },
    projects: createProjectsArea(sdkContext),
    plugins: createPluginsArea(sdkContext),
    providers: createProvidersArea(sdkContext),
    skills: createSkillsArea(sdkContext),
    status: createStatusArea(sdkContext),
    system: createSystemArea(sdkContext),
    terminals: createTerminalsArea(sdkContext),
    theme: createThemeArea(sdkContext),
    threadSections: createThreadSectionsArea(sdkContext),
    threads: createThreadsArea(sdkContext),
  };
  return "guide" in args ? { ...areas, guide: args.guide } : areas;
}
