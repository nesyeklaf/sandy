import { describe, expect, it } from "vitest";
import { getSkillSelection } from "@sandy/db";
import {
  skillSelectionUpdateResultSchema,
  skillSelectionViewSchema,
} from "@sandy/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";

describe("skill selection settings", () => {
  it("defaults to inherit and reads without writing", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/skill-selection",
      );
      expect(response.status).toBe(200);
      const view = skillSelectionViewSchema.parse(await readJson(response));
      expect(view.selection).toEqual({ mode: "inherit" });
      expect(view).not.toHaveProperty("pendingThreadIds");
      expect(getSkillSelection(harness.db)).toEqual({ mode: "inherit" });
    });
  });

  it("stores a canonical selection and names the running threads that keep the old one", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const running = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const put = (body: unknown) =>
        harness.app.request("/api/v1/settings/skill-selection", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const duplicated = await put({
        mode: "disable",
        names: ["beta", "alpha", "beta"],
      });
      expect(duplicated.status).toBe(400);
      expect(getSkillSelection(harness.db)).toEqual({ mode: "inherit" });

      const first = await put({ mode: "disable", names: ["beta", "alpha"] });
      expect(first.status).toBe(200);
      const changed = skillSelectionUpdateResultSchema.parse(
        await readJson(first),
      );
      expect(changed.selection).toEqual({
        mode: "disable",
        names: ["alpha", "beta"],
      });
      expect(changed.pendingThreadIds).toEqual([running.id]);
      expect(getSkillSelection(harness.db)).toEqual({
        mode: "disable",
        names: ["alpha", "beta"],
      });

      const repeated = skillSelectionUpdateResultSchema.parse(
        await readJson(await put({ mode: "disable", names: ["alpha", "beta"] })),
      );
      expect(repeated.pendingThreadIds).toEqual([]);
    });
  });

  it("rejects a selection that mixes modes", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/skill-selection",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "inherit", names: ["alpha"] }),
        },
      );
      expect(response.status).toBe(400);
      expect(getSkillSelection(harness.db)).toEqual({ mode: "inherit" });
    });
  });
});
