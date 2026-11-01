import { getThread, listEvents } from "@sandy/db";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { seedEnvironment, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

function putDirectory(harness: TestAppHarness, threadId: string, path: string) {
  return harness.app.request(
    `/api/v1/threads/${threadId}/environment-directory`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
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
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(target.id);
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/operation",
        ),
      ).toHaveLength(1);
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

  it("refuses a path that is not absolute", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      const responsePromise = putDirectory(harness, thread.id, "relative/dir");
      const release = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, release, {
        providerCheckpointId: null,
      });
      const response = await responsePromise;

      expect(response.status).toBe(409);
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        thread.environmentId,
      );
    });
  });
});
