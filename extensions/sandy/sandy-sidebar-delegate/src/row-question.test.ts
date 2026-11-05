import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { askingThreadOf, questionAnswer, rowQuestionOf } from "./row-question";

type Interactions = Parameters<typeof rowQuestionOf>[0];

const base = {
  threadId: "thr_q",
  status: "pending",
  statusReason: null,
  createdAt: 10,
  resolvedAt: null,
  turnId: "turn_1",
  providerId: "codex",
  providerThreadId: "p_1",
  providerRequestId: "r_1",
};

const question = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []) =>
  [
    {
      ...base,
      id: "int_q",
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "branch",
            prompt: "Create a branch?",
            multiSelect: false,
            allowFreeText: false,
            required: true,
            options: [
              { value: "yes", label: "Yes, create feat/login" },
              { value: "no", label: "No, work on main" },
            ],
            ...overrides,
          },
          ...extra,
        ],
      },
    },
  ] as unknown as Interactions;

describe("rowQuestionOf", () => {
  it("offers the options of a single choice question", () => {
    const row = rowQuestionOf(question());
    expect(row).toMatchObject({
      interactionId: "int_q",
      threadId: "thr_q",
      kind: "question",
      prompt: "Create a branch?",
      questionId: "branch",
      options: [
        { value: "yes", label: "Yes, create feat/login" },
        { value: "no", label: "No, work on main" },
      ],
    });
    expect(questionAnswer(row!, row!.options[1]!)).toEqual({
      kind: "user_answer",
      answers: { branch: { selected: ["no"] } },
    });
  });

  it.each([
    ["a multi select question", question({ multiSelect: true }), "Create a branch?"],
    ["a free text question", question({ options: undefined, allowFreeText: true }), "Create a branch?"],
    [
      "several questions",
      question({}, [{ id: "name", prompt: "Name?", multiSelect: false, allowFreeText: true, required: true }]),
      "Create a branch? (+1 more)",
    ],
  ])("shows only the prompt for %s", (_name, interactions, prompt) => {
    expect(rowQuestionOf(interactions)).toMatchObject({ kind: "question", prompt, questionId: null, options: [] });
  });

  it("never offers one-tap approval", () => {
    const approval = (reason: string | null) =>
      [
        {
          ...base,
          id: "int_a",
          payload: {
            kind: "approval",
            reason,
            availableDecisions: ["allow_once", "deny"],
            subject: {
              kind: "command",
              itemId: "i",
              command: "rm -rf build",
              cwd: null,
              actions: [],
              sessionGrant: null,
            },
          },
        },
      ] as unknown as Interactions;
    expect(rowQuestionOf(approval("Clean the build folder"))).toMatchObject({
      kind: "approval",
      prompt: "Clean the build folder",
      options: [],
    });
    expect(rowQuestionOf(approval(null))?.prompt).toBe("Wants to run a command");
  });

  it("shows a plugin form by its title", () => {
    const form = [
      { ...base, id: "int_f", payload: { kind: "plugin", title: "Pick a reviewer", data: {} } },
    ] as unknown as Interactions;
    expect(rowQuestionOf(form)).toMatchObject({ kind: "form", prompt: "Pick a reviewer", options: [] });
  });

  it("ignores interactions that are no longer pending and picks the oldest open one", () => {
    const [open] = question();
    const interactions = [
      { ...open!, id: "int_done", status: "resolved" },
      { ...open!, id: "int_new", createdAt: 30 },
      { ...open!, id: "int_old", createdAt: 20 },
    ] as unknown as Interactions;
    expect(rowQuestionOf(interactions)?.interactionId).toBe("int_old");
    expect(rowQuestionOf([interactions[0]!])).toBeNull();
  });
});

const thread = (fields: Partial<PluginSidebarThread> & { id: string }) =>
  ({ hasPendingInteraction: false, isArchived: false, ...fields }) as PluginSidebarThread;

describe("askingThreadOf", () => {
  it("finds the asking thread in the row or deep in its folded children", () => {
    const parent = thread({ id: "parent" });
    const child = thread({ id: "child", parentThreadId: "parent" });
    const grandchild = thread({ id: "grandchild", parentThreadId: "child", hasPendingInteraction: true });
    const children = new Map([
      ["parent", [child]],
      ["child", [grandchild]],
    ]);
    expect(askingThreadOf(parent, children)?.id).toBe("grandchild");
    expect(askingThreadOf({ ...parent, hasPendingInteraction: true }, children)?.id).toBe("parent");
    expect(askingThreadOf(parent, new Map([["parent", [{ ...child, isArchived: true }]]]))).toBeNull();
  });
});
