import type {
  DiscoveredSkill,
  HostDaemonOnlineRpcRequestMessage,
} from "@sandy/host-daemon-contract";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppSettings, setAppSettings, setExperiments } from "@sandy/db";
import { defaultExperiments } from "@sandy/domain";
import {
  skillContentResponseSchema,
  skillFilesResponseSchema,
  skillListResponseSchema,
} from "@sandy/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerHasNativeRootSurface } from "../../src/services/providers/native-roots.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { declaredNativeRootSet } from "../helpers/provider-registry.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

interface SkillRpcStub {
  requests: HostDaemonOnlineRpcRequestMessage[];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function registerSkillRpc(
  harness: Parameters<typeof registerHostRpcResponder>[0],
  args: {
    hostId: string;
    sessionId: string;
    skillsByProvider?: Record<string, DiscoveredSkill[]>;
    deletedPath?: string;
    listedFiles?: string[];
    fileContents?: Record<string, string>;
    fileContentsByRoot?: Record<string, string>;
    readFileErrorCode?: string;
    writeConflicts?: boolean;
  },
): SkillRpcStub {
  const stub: SkillRpcStub = { requests: [] };
  const responder = registerHostRpcResponder(harness, {
    hostId: args.hostId,
    sessionId: args.sessionId,
    handle: (request) => {
      if (request.command.type === "host.list_skills") {
        return {
          ok: true,
          result: {
            skills: args.skillsByProvider?.[request.command.providerId] ?? [],
          },
        };
      }
      if (
        request.command.type === "plugin.host.call" &&
        request.command.method === "resolveNativeRoots"
      ) {
        return { ok: true, result: { output: { skills: [], commands: [] } } };
      }
      if (request.command.type === "host.delete_skill") {
        return {
          ok: true,
          result: { deletedPath: args.deletedPath ?? "/deleted" },
        };
      }
      if (request.command.type === "host.list_files") {
        const files = args.listedFiles ?? ["SKILL.md"];
        return {
          ok: true,
          result: {
            files: files.map((path) => ({
              path,
              name: path.split("/").at(-1) ?? path,
            })),
            truncated: false,
          },
        };
      }
      if (
        request.command.type === "host.read_file" &&
        args.readFileErrorCode !== undefined
      ) {
        return {
          ok: false,
          errorCode: args.readFileErrorCode,
          errorMessage: "File size 26214401 bytes exceeds the 25 MB limit",
        };
      }
      if (request.command.type === "host.read_file") {
        const content =
          (request.command.rootPath === undefined
            ? undefined
            : args.fileContentsByRoot?.[request.command.rootPath]) ??
          args.fileContents?.[request.command.path] ??
          "# Skill content";
        return {
          ok: true,
          result: {
            path: request.command.path,
            content,
            contentEncoding: "utf8" as const,
            sizeBytes: content.length,
            sha256: "0".repeat(64),
          },
        };
      }
      if (request.command.type === "host.write_file") {
        return {
          ok: true,
          result: args.writeConflicts
            ? {
                outcome: "conflict" as const,
                currentSha256: "2".repeat(64),
              }
            : {
                outcome: "written" as const,
                sha256: "1".repeat(64),
                sizeBytes: request.command.content.length,
              },
        };
      }
      if (request.command.type === "host.write_skill") {
        return {
          ok: true,
          result: args.writeConflicts
            ? {
                outcome: "conflict" as const,
                currentSha256: "2".repeat(64),
              }
            : {
                outcome: "written" as const,
                filePath: `/data/skills/${request.command.name}/SKILL.md`,
                sha256: "1".repeat(64),
              },
        };
      }
      throw new Error(`Unexpected RPC command ${request.command.type}`);
    },
  });
  stub.requests = responder.requests;
  return stub;
}

function discovered(
  name: string,
  rootKind: DiscoveredSkill["rootKind"],
  filePath: string,
): DiscoveredSkill {
  return {
    id: skillId(filePath),
    name,
    description: `${name} skill`,
    rootKind,
    filePath,
    realPath: filePath,
    contentSha256: createHash("sha256").update(filePath).digest("hex"),
    linked: false,
  };
}

function skillId(filePath: string): string {
  return `skill_${createHash("sha256").update(filePath).digest("hex")}`;
}

async function writePluginSkillFixture(rootPath: string): Promise<{
  pluginRootPath: string;
  skillFilePath: string;
}> {
  const pluginRootPath = join(rootPath, "sandy-plugin-skill-catalog-fixture");
  const skillRootPath = join(pluginRootPath, "skills", "plugin-notes");
  await mkdir(skillRootPath, { recursive: true });
  await writeFile(
    join(pluginRootPath, "package.json"),
    JSON.stringify({
      name: "sandy-plugin-skill-catalog-fixture",
      version: "0.1.0",
      sandy: {
        name: "Skill catalog fixture",
        description: "Contributes one readable skill.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
    "utf8",
  );
  await writeFile(
    join(pluginRootPath, "server.ts"),
    "export default function plugin() {}\n",
    "utf8",
  );
  const skillFilePath = join(skillRootPath, "SKILL.md");
  await writeFile(
    skillFilePath,
    [
      "---",
      "name: plugin-notes",
      "description: Read notes contributed by the fixture plugin.",
      "---",
      "",
      "# Plugin notes",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(skillRootPath, "reference.md"),
    "# Plugin reference\n",
    "utf8",
  );
  return { pluginRootPath, skillFilePath };
}

describe("public project skills route", () => {
  it("collapses identical registrations across scopes while keeping hidden IDs usable for reads and mutations and different contents distinct", async () => {
    await withTestHarness(
      { sharedSkillRoots: { user: [".agents/skills"], project: [] } },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-index-aliases",
        });
        seedPrimaryHost(harness.deps, host.id);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/index-aliases",
        });
        const shared = discovered(
          "review",
          "shared-user",
          "/home/.agents/skills/review/SKILL.md",
        );
        const native = {
          ...discovered(
            "review",
            "provider-user",
            "/home/.claude/skills/review/SKILL.md",
          ),
          contentSha256: shared.contentSha256,
        };
        const different = discovered(
          "review",
          "provider-user",
          "/home/.claude/skills/other/SKILL.md",
        );
        const alias = {
          ...discovered(
            "critique",
            "provider-user",
            "/home/.claude/skills/critique/SKILL.md",
          ),
          contentSha256: shared.contentSha256,
        };
        const stub = registerSkillRpc(harness, {
          hostId: host.id,
          sessionId: session.id,
          skillsByProvider: {
            "sandy-shared": [shared],
            "claude-code": [native, different, alias],
          },
        });
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/skills?environmentId=`,
        );
        expect(response.status).toBe(200);
        const listed = skillListResponseSchema.parse(await readJson(response));
        expect(
          listed.skills
            .filter((skill) => skill.name === "review")
            .map((skill) => skill.id),
        ).toEqual([shared.id, different.id]);
        expect(listed.skills.map((skill) => skill.id)).toContain(alias.id);
        const read = await harness.app.request(
          `/api/v1/projects/${project.id}/skills/content?environmentId=&skillId=${native.id}&path=SKILL.md`,
        );
        expect(read.status).toBe(200);
        const edit = await harness.app.request(
          `/api/v1/projects/${project.id}/skills/content`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              skillId: native.id,
              environmentId: null,
              content: "# Updated native review",
              revision: "0".repeat(64),
            }),
          },
        );
        expect(edit.status).toBe(200);
        expect(stub.requests.map((request) => request.command)).toContainEqual(
          expect.objectContaining({
            type: "host.write_file",
            path: native.filePath,
            content: "# Updated native review",
          }),
        );
        const remove = await harness.app.request(
          `/api/v1/projects/${project.id}/skills`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ skillId: native.id, environmentId: null }),
          },
        );
        expect(remove.status).toBe(200);
        expect(stub.requests.map((request) => request.command)).toContainEqual(
          expect.objectContaining({
            type: "host.delete_skill",
            rootPath: "/home/.claude/skills",
            name: "review",
          }),
        );
      },
    );
  });

  it("lists configured shared roots as read-only provider-neutral skills", async () => {
    await withTestHarness(
      {
        sharedSkillRoots: {
          user: [".agents/skills"],
          project: [".agents/skills"],
        },
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-shared-skill-list",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/shared-skill-list",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/shared-skill-list",
        });
        registerSkillRpc(harness, {
          hostId: host.id,
          sessionId: session.id,
          skillsByProvider: {
            "sandy-shared": [
              discovered(
                "portable-review",
                "shared-project",
                "/tmp/shared-skill-list/.agents/skills/portable-review/SKILL.md",
              ),
              discovered(
                "repo-sandy-skill",
                "sandy-project",
                "/tmp/shared-skill-list/.sandy/skills/repo-sandy-skill/SKILL.md",
              ),
            ],
          },
        });
        const warn = vi.spyOn(harness.deps.logger, "warn");

        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/skills?environmentId=${environment.id}`,
        );
        expect(response.status).toBe(200);
        const body = skillListResponseSchema.parse(await readJson(response));

        expect(body.skills).toContainEqual({
          id: skillId(
            "/tmp/shared-skill-list/.agents/skills/portable-review/SKILL.md",
          ),
          name: "portable-review",
          description: "portable-review skill",
          provider: null,
          scope: "shared-project",
          pluginId: null,
          filePath:
            "/tmp/shared-skill-list/.agents/skills/portable-review/SKILL.md",
          manageable: false,
          providers: [],
          duplicates: [],
        });
        expect(body.skills.map((skill) => skill.name)).not.toContain(
          "repo-sandy-skill",
        );
        expect(warn).not.toHaveBeenCalledWith(
          expect.anything(),
          "Skipping invalid shared skill",
        );

        setAppSettings(harness.deps.db, {
          ...getAppSettings(harness.deps.db),
          disabledSkillSources: ["shared"],
        });
        const switchedOff = skillListResponseSchema.parse(
          await readJson(
            await harness.app.request(
              `/api/v1/projects/${project.id}/skills?environmentId=${environment.id}`,
            ),
          ),
        );
        expect(switchedOff.skills.map((skill) => skill.name)).not.toContain(
          "portable-review",
        );
      },
    );
  });

  it("maps scope, de-dupes shared sandy skills, and sorts the listing", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-skills",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/skills-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/skills-env",
      });
      const sandySkill = discovered(
        "sandy-helper",
        "sandy-data-dir",
        "/data/skills/sandy-helper/SKILL.md",
      );
      const stub = registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          "claude-code": [
            sandySkill,
            discovered(
              "cp",
              "provider-project",
              "/cwd/.claude/skills/cp/SKILL.md",
            ),
            discovered(
              "cu",
              "provider-user",
              "/home/.claude/skills/cu/SKILL.md",
            ),
          ],
          codex: [
            sandySkill,
            discovered(
              "cx",
              "provider-user",
              "/home/.codex/skills/cx/SKILL.md",
            ),
          ],
          "acp-cursor": [
            {
              ...discovered(
                "impeccable",
                "provider-project",
                "/cwd/.cursor/skills/impeccable/SKILL.md",
              ),
              linked: true,
            },
          ],
        },
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/skills?environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = skillListResponseSchema.parse(await readJson(response));
      expect(body.skills).toEqual([
        {
          id: skillId("/data/skills/sandy-helper/SKILL.md"),
          name: "sandy-helper",
          description: "sandy-helper skill",
          provider: null,
          scope: "sandy-user",
          pluginId: null,
          filePath: "/data/skills/sandy-helper/SKILL.md",
          manageable: true,
          providers: [],
          duplicates: [],
        },
        {
          id: skillId("/cwd/.cursor/skills/impeccable/SKILL.md"),
          name: "impeccable",
          description: "impeccable skill",
          provider: "acp-cursor",
          scope: "provider-project",
          pluginId: null,
          filePath: "/cwd/.cursor/skills/impeccable/SKILL.md",
          manageable: false,
          providers: ["acp-cursor"],
          duplicates: [],
        },
        {
          id: skillId("/cwd/.claude/skills/cp/SKILL.md"),
          name: "cp",
          description: "cp skill",
          provider: "claude-code",
          scope: "provider-project",
          pluginId: null,
          filePath: "/cwd/.claude/skills/cp/SKILL.md",
          manageable: true,
          providers: ["claude-code"],
          duplicates: [],
        },
        {
          id: skillId("/home/.claude/skills/cu/SKILL.md"),
          name: "cu",
          description: "cu skill",
          provider: "claude-code",
          scope: "provider-user",
          pluginId: null,
          filePath: "/home/.claude/skills/cu/SKILL.md",
          manageable: true,
          providers: ["claude-code"],
          duplicates: [],
        },
        {
          id: skillId("/home/.codex/skills/cx/SKILL.md"),
          name: "cx",
          description: "cx skill",
          provider: "codex",
          scope: "provider-user",
          pluginId: null,
          filePath: "/home/.codex/skills/cx/SKILL.md",
          manageable: true,
          providers: ["codex"],
          duplicates: [],
        },
      ]);
      const listed = stub.requests
        .map((request) => request.command)
        .filter((command) => command.type === "host.list_skills");
      const surfaced = harness.deps.providerRegistry
        .list()
        .filter(providerHasNativeRootSurface)
        .map((registration) => registration.info.id)
        .sort();
      expect(surfaced).toEqual(
        expect.arrayContaining(["acp-cursor", "claude-code", "codex", "pi"]),
      );
      expect(listed.map((command) => command.providerId).sort()).toEqual(
        surfaced,
      );
      for (const command of listed) {
        expect(command).toEqual({
          type: "host.list_skills",
          providerId: command.providerId,
          cwd: "/tmp/skills-env",
          nativeRoots: declaredNativeRootSet(
            harness.deps.providerRegistry,
            command.providerId,
          ),
        });
      }
    });
  });

  it("lists and reads a sandy plugin skill from the authoritative runtime catalog", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "sandy-plugin-skill-route-"));
    try {
      await withTestHarness(async (harness) => {
        setExperiments(harness.db, {
          ...defaultExperiments,
        });
        const { pluginRootPath, skillFilePath } =
          await writePluginSkillFixture(workDir);
        const installed =
          await harness.pluginService.installPath(pluginRootPath);
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-plugin-skill",
        });
        seedPrimaryHost(harness.deps, host.id);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/plugin-skill-project",
        });
        const stub = registerSkillRpc(harness, {
          hostId: host.id,
          sessionId: session.id,
        });

        const listResponse = await harness.app.request(
          `/api/v1/projects/${project.id}/skills?environmentId=`,
        );
        expect(listResponse.status).toBe(200);
        const listed = skillListResponseSchema.parse(
          await readJson(listResponse),
        );
        const matches = listed.skills.filter(
          (skill) => skill.name === "plugin-notes",
        );
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({
          name: "plugin-notes",
          description: "Read notes contributed by the fixture plugin.",
          provider: null,
          scope: "plugin",
          pluginId: installed.id,
          filePath: skillFilePath,
          manageable: false,
        });

        const skill = matches[0];
        if (skill === undefined) throw new Error("Expected plugin skill");
        const query = new URLSearchParams({
          skillId: skill.id,
          environmentId: "",
          path: "reference.md",
        });
        const contentResponse = await harness.app.request(
          `/api/v1/projects/${project.id}/skills/content?${query}`,
        );
        expect(contentResponse.status).toBe(200);
        expect(
          skillContentResponseSchema.parse(await readJson(contentResponse)),
        ).toMatchObject({ content: "# Plugin reference\n" });
        expect(
          stub.requests.some(
            (request) => request.command.type === "host.read_file",
          ),
        ).toBe(false);
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("deletes a sandy skill via the confined daemon primitive", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-skill-delete",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/skill-delete-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/skill-delete-env",
      });
      const stub = registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          "claude-code": [
            discovered(
              "sandy-helper",
              "sandy-data-dir",
              "/data/skills/sandy-helper/SKILL.md",
            ),
          ],
        },
        deletedPath: "/data/skills/sandy-helper",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/skills`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillId: skillId("/data/skills/sandy-helper/SKILL.md"),
            environmentId: environment.id,
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        deletedPath: "/data/skills/sandy-helper",
      });
      const deleteCommand = stub.requests
        .map((request) => request.command)
        .find((command) => command.type === "host.delete_skill");
      expect(deleteCommand).toEqual({
        type: "host.delete_skill",
        scope: "sandy-user",
        name: "sandy-helper",
        cwd: "/tmp/skill-delete-env",
        rootPath: null,
      });
    });
  });

  it("deletes a user-owned provider skill through its resolved root", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provider-skill-delete",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/provider-skill-delete-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provider-skill-delete-env",
      });
      const stub = registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          "claude-code": [
            discovered(
              "moss-notes",
              "provider-user",
              "/home/.claude/skills/moss-notes/SKILL.md",
            ),
          ],
          codex: [],
        },
        deletedPath: "/home/.claude/skills/moss-notes",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/skills`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillId: skillId("/home/.claude/skills/moss-notes/SKILL.md"),
            environmentId: environment.id,
          }),
        },
      );

      expect(response.status).toBe(200);
      const deleteCommand = stub.requests
        .map((request) => request.command)
        .find((command) => command.type === "host.delete_skill");
      expect(deleteCommand).toEqual({
        type: "host.delete_skill",
        scope: "provider-user",
        name: "moss-notes",
        cwd: "/tmp/provider-skill-delete-env",
        rootPath: "/home/.claude/skills",
      });
    });
  });

  it("returns 413 when the daemon rejects an oversized skill file", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-skill-too-large",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/skill-too-large-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/skill-too-large-env",
      });
      registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          codex: [
            discovered(
              "documents",
              "provider-user",
              "/home/.codex/skills/documents/SKILL.md",
            ),
          ],
        },
        readFileErrorCode: "file_too_large",
      });
      const query = new URLSearchParams({
        skillId: skillId("/home/.codex/skills/documents/SKILL.md"),
        environmentId: environment.id,
        path: "SKILL.md",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/skills/content?${query}`,
      );

      expect(response.status).toBe(413);
      expect(await readJson(response)).toMatchObject({
        code: "file_too_large",
      });
    });
  });

  it("lists bundled skill files and reads the selected file relative to the skill root", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-skill-files",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/skill-files-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/skill-files-env",
      });
      const stub = registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          codex: [
            discovered(
              "documents",
              "provider-user",
              "/home/.codex/skills/documents/SKILL.md",
            ),
          ],
        },
        listedFiles: ["references/layout.md", "SKILL.md"],
        fileContents: {
          "/home/.codex/skills/documents/references/layout.md":
            "# Layout reference",
        },
      });
      const query = new URLSearchParams({
        skillId: skillId("/home/.codex/skills/documents/SKILL.md"),
        environmentId: environment.id,
      });

      const filesResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/skills/files?${query}`,
      );
      expect(filesResponse.status).toBe(200);
      expect(
        skillFilesResponseSchema.parse(await readJson(filesResponse)),
      ).toEqual({
        files: ["SKILL.md", "references/layout.md"],
        truncated: false,
      });

      query.set("path", "references/layout.md");
      const contentResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/skills/content?${query}`,
      );
      expect(contentResponse.status).toBe(200);
      expect(
        skillContentResponseSchema.parse(await readJson(contentResponse)),
      ).toEqual({
        content: "# Layout reference",
        revision: "0".repeat(64),
      });
      expect(stub.requests.map((request) => request.command)).toContainEqual({
        type: "host.read_file",
        path: "/home/.codex/skills/documents/references/layout.md",
        rootPath: "/home/.codex/skills/documents",
        followRootSymlink: true,
      });

      for (const [hiddenPath, status] of [
        [".env", 404],
        ["references/../../secrets.md", 404],
        ["/etc/passwd", 400],
      ] as const) {
        query.set("path", hiddenPath);
        const rejected = await harness.app.request(
          `/api/v1/projects/${project.id}/skills/content?${query}`,
        );
        expect(rejected.status).toBe(status);
      }
      expect(
        stub.requests.filter(
          (request) => request.command.type === "host.read_file",
        ),
      ).toHaveLength(1);
      expect(stub.requests.map((request) => request.command)).toContainEqual(
        expect.objectContaining({
          type: "host.list_files",
          followRootSymlink: true,
          path: "/home/.codex/skills/documents",
        }),
      );
    });
  });

  it("uses opaque IDs to read duplicate-name skills from distinct roots", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-duplicate-skills",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/duplicate-skills-project",
      });
      const claudePath = "/home/.claude/skills/review/SKILL.md";
      const codexPath = "/home/.codex/skills/review/SKILL.md";
      registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          "claude-code": [discovered("review", "provider-user", claudePath)],
          codex: [discovered("review", "provider-user", codexPath)],
        },
        fileContentsByRoot: {
          "/home/.claude/skills/review": "# Claude review",
          "/home/.codex/skills/review": "# Codex review",
        },
      });

      const read = async (id: string) => {
        const query = new URLSearchParams({
          skillId: id,
          path: "SKILL.md",
          environmentId: "",
        });
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/skills/content?${query}`,
        );
        expect(response.status).toBe(200);
        return skillContentResponseSchema.parse(await readJson(response));
      };

      await expect(read(skillId(claudePath))).resolves.toMatchObject({
        content: "# Claude review",
      });
      await expect(read(skillId(codexPath))).resolves.toMatchObject({
        content: "# Codex review",
      });
    });
  });

  it("edits a Claude user skill through its authoritative local path", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-claude-skill-edit",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/claude-skill-edit-project",
      });
      const stub = registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          "claude-code": [
            discovered(
              "moss-notes",
              "provider-user",
              "/home/.claude/skills/moss-notes/SKILL.md",
            ),
          ],
        },
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/skills/content`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillId: skillId("/home/.claude/skills/moss-notes/SKILL.md"),
            environmentId: null,
            content: "# Updated Moss notes",
            revision: "0".repeat(64),
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        filePath: "/home/.claude/skills/moss-notes/SKILL.md",
        revision: "1".repeat(64),
      });
      expect(stub.requests.map((request) => request.command)).toContainEqual({
        type: "host.write_file",
        path: "/home/.claude/skills/moss-notes/SKILL.md",
        rootPath: "/home/.claude/skills/moss-notes",
        content: "# Updated Moss notes",
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: "0".repeat(64),
      });
    });
  });

  it("returns 409 for stale sandy and provider skill revisions", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stale-skill-edit",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/stale-skill-edit-project",
      });
      const sandyPath = "/data/skills/review/SKILL.md";
      const providerPath = "/home/.claude/skills/review/SKILL.md";
      const stub = registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        skillsByProvider: {
          "claude-code": [
            discovered("review", "sandy-data-dir", sandyPath),
            discovered("review", "provider-user", providerPath),
          ],
        },
        writeConflicts: true,
      });

      for (const id of [skillId(sandyPath), skillId(providerPath)]) {
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/skills/content`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              skillId: id,
              environmentId: null,
              content: "# Stale",
              revision: "0".repeat(64),
            }),
          },
        );
        expect(response.status).toBe(409);
      }

      expect(stub.requests.map((request) => request.command)).toContainEqual({
        type: "host.write_skill",
        scope: "sandy-user",
        name: "review",
        cwd: "/tmp/stale-skill-edit-project",
        content: "# Stale",
        expectedSha256: "0".repeat(64),
      });
      expect(stub.requests.map((request) => request.command)).toContainEqual({
        type: "host.write_file",
        path: providerPath,
        rootPath: "/home/.claude/skills/review",
        content: "# Stale",
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: "0".repeat(64),
      });
    });
  });

  it("saves a server-owned sandy user skill on the server's disk with a revision check", async () => {
    await withTestHarness(async (harness) => {
      const skillFilePath = join(
        harness.deps.config.dataDir,
        "skills",
        "notes",
        "SKILL.md",
      );
      await mkdir(join(skillFilePath, ".."), { recursive: true });
      await writeFile(
        skillFilePath,
        "---\nname: notes\ndescription: Notes.\n---\n",
      );
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-server-owned-skill-edit",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/server-owned-skill-edit-project",
      });
      const stub = registerSkillRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      const listed = skillListResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/projects/${project.id}/skills?environmentId=`,
          ),
        ),
      );
      const skill = listed.skills.find((entry) => entry.name === "notes");
      if (skill === undefined) throw new Error("Expected server-owned skill");
      const read = skillContentResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/projects/${project.id}/skills/content?${new URLSearchParams(
              { skillId: skill.id, environmentId: "", path: "SKILL.md" },
            )}`,
          ),
        ),
      );
      const savedContent = "---\nname: notes\ndescription: Saved.\n---\n";
      const save = (revision: string) =>
        harness.app.request(`/api/v1/projects/${project.id}/skills/content`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillId: skill.id,
            environmentId: null,
            content: savedContent,
            revision,
          }),
        });

      expect((await save(read.revision)).status).toBe(200);
      await expect(readFile(skillFilePath, "utf8")).resolves.toBe(savedContent);
      expect((await save(read.revision)).status).toBe(409);
      await expect(readFile(skillFilePath, "utf8")).resolves.toBe(savedContent);
      expect(
        stub.requests.some((request) =>
          ["host.write_file", "host.write_skill"].includes(
            request.command.type,
          ),
        ),
      ).toBe(false);
    });
  });

  it("rejects a sandy-project delete when no workspace resolves", async () => {
    await withTestHarness(async (harness) => {
      const { host: hostA, session } = seedHostSession(harness.deps, {
        id: "host-primary",
      });
      const hostB = seedHost(harness.deps, { id: "host-source" });
      seedPrimaryHost(harness.deps, hostA.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: hostB.id,
        path: "/tmp/other-host-project",
      });
      registerSkillRpc(harness, {
        hostId: hostA.id,
        sessionId: session.id,
        skillsByProvider: {
          "claude-code": [
            discovered(
              "sandy-helper",
              "sandy-project",
              "/missing/.sandy/skills/sandy-helper/SKILL.md",
            ),
          ],
        },
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/skills`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillId: skillId("/missing/.sandy/skills/sandy-helper/SKILL.md"),
            environmentId: null,
          }),
        },
      );

      expect(response.status).toBe(409);
    });
  });
});
