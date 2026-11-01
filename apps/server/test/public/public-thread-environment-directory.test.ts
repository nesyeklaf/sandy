import {
  acquireProjectAttachmentOwnership,
  createPromptHistoryEntry,
  getProjectAttachment,
  getEnvironment,
  getThread,
  listEvents,
  listStoredProjectPromptHistoryRows,
  listThreadAttachmentPaths,
} from "@sandy/db";
import { describe, expect, it } from "vitest";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import { storeAttachment } from "../../src/services/projects/attachments.js";
import {
  seedEnvironment,
  seedProjectWithSource,
  seedThreadFixture,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

function putDirectory(
  harness: TestAppHarness,
  threadId: string,
  path: string,
  projectId?: string,
) {
  return harness.app.request(
    `/api/v1/threads/${threadId}/environment-directory`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path,
        ...(projectId === undefined ? {} : { projectId }),
      }),
    },
  );
}

describe("thread environment directory", () => {
  it("stops the runtime, reattaches the thread and records the move", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, thread } = seedThreadFixture(harness, {
        environment: { path: "/tmp/dir-move-source" },
        thread: { status: "idle" },
      });
      const target = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/dir-move-target",
      });

      const responsePromise = putDirectory(
        harness,
        thread.id,
        "/tmp/dir-move-target/",
      );
      const release = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(release.command).toMatchObject({ intent: "release" });
      await reportQueuedCommandSuccess(harness, release, {
        providerCheckpointId: null,
      });
      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        changed: true,
        path: "/tmp/dir-move-target",
        projectId: project.id,
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(target.id);
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/operation",
        ),
      ).toHaveLength(1);
    });
  });

  it("moves the thread into another project and takes its prompt history along", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, thread } = seedThreadFixture(harness, {
        environment: { path: "/tmp/project-move-source" },
        thread: { status: "idle" },
      });
      const { project: targetProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Target",
        path: "/tmp/project-move-target-source",
      });
      const targetEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: targetProject.id,
        path: "/tmp/project-move-target",
      });
      const uploaded = await storeAttachment(
        harness.db,
        harness.deps.config.dataDir,
        thread.projectId,
        new File(["hello"], "note.txt", { type: "text/plain" }),
      );
      acquireProjectAttachmentOwnership(harness.db, thread.id, [uploaded.path]);
      createPromptHistoryEntry(harness.db, {
        projectId: thread.projectId,
        threadId: thread.id,
        scope: "project",
        requestSequence: 1,
        input: textInput("hello"),
      });

      const responsePromise = putDirectory(
        harness,
        thread.id,
        "/tmp/project-move-target",
        targetProject.id,
      );
      const release = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, release, {
        providerCheckpointId: null,
      });
      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        changed: true,
        path: "/tmp/project-move-target",
        projectId: targetProject.id,
      });
      const moved = getThread(harness.db, thread.id);
      expect(moved?.projectId).toBe(targetProject.id);
      expect(moved?.environmentId).toBe(targetEnvironment.id);
      expect(getEnvironment(harness.db, environment.id)?.projectId).toBe(
        thread.projectId,
      );
      expect(
        getProjectAttachment(harness.db, targetProject.id, uploaded.path),
      ).toBeTruthy();
      expect(listThreadAttachmentPaths(harness.db, thread.id)).toEqual([
        uploaded.path,
        uploaded.path,
      ]);
      expect(
        listStoredProjectPromptHistoryRows(harness.db, {
          projectId: targetProject.id,
          limit: 10,
        }),
      ).toHaveLength(1);
      expect(
        listStoredProjectPromptHistoryRows(harness.db, {
          projectId: thread.projectId,
          limit: 10,
        }),
      ).toEqual([]);
    });
  });

  it("answers 404 for an unknown target project before stopping anything", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      const response = await putDirectory(
        harness,
        thread.id,
        "/tmp/anywhere",
        "proj_missing",
      );

      expect(response.status).toBe(404);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toEqual([]);
    });
  });

  it("refuses a thread that is starting or active", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      const response = await putDirectory(harness, thread.id, "/tmp/elsewhere");

      expect(response.status).toBe(409);
    });
  });

  it("rejects a path that is not absolute before stopping anything", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      const response = await putDirectory(harness, thread.id, "relative/dir");

      expect(response.status).toBe(400);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toEqual([]);
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        thread.environmentId,
      );
    });
  });

  it("does not move the thread when stopping its runtime fails", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, thread } = seedThreadFixture(harness, {
        environment: { path: "/tmp/dir-move-fail-source" },
        thread: { status: "idle" },
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/dir-move-fail-target",
      });

      const responsePromise = putDirectory(
        harness,
        thread.id,
        "/tmp/dir-move-fail-target",
      );
      const release = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandError(harness, release, {
        errorCode: "test_release_failure",
        errorMessage: "Runtime shutting down",
      });
      const response = await responsePromise;

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        thread.environmentId,
      );
    });
  });
});
