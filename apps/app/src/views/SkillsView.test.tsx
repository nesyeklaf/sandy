// @vitest-environment jsdom

import type { ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { focusManager } from "@tanstack/react-query";
import type { ProviderInfo } from "@sandy/domain";
import type { SkillSummary } from "@sandy/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeProviderInfo } from "@sandy/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";
import { SkillDetailView } from "../components/tools/SkillDetailView";
import {
  SkillDetailDialogView,
  SkillsOverview,
} from "../components/tools/SkillsCollection";
import { SkillsLibrary } from "../components/tools/SkillsLibrary";
import { focusWithKeyboard } from "@/test/keyboard-focus";

afterEach(() => {
  focusManager.setFocused(undefined);
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  const provider =
    overrides.provider === undefined ? "claude-code" : overrides.provider;
  return {
    id: `skill_${"a".repeat(64)}`,
    name: "code-review",
    description: "Review the current diff.",
    provider,
    scope: "provider-user",
    pluginId: null,
    filePath: "/home/u/.claude/skills/code-review/SKILL.md",
    manageable: true,
    providers: provider === null ? [] : [provider],
    duplicates: [],
    ...overrides,
  };
}

function renderLibrarySkillRoute() {
  vi.spyOn(sdk.providers, "list").mockResolvedValue([]);
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          skills: [],
          pagination: { page: 0, perPage: 24, total: 0, hasMore: false },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
  renderDom(
    <MemoryRouter initialEntries={["/skills/library/skill_missing"]}>
      <QueryClientWrapper>
        <Routes>
          <Route path="/skills/library/:skillId" element={<SkillsLibrary />} />
        </Routes>
      </QueryClientWrapper>
    </MemoryRouter>,
  );
  return fetchMock;
}

const NO_PROVIDER_ROSTER: ReadonlyMap<string, ProviderInfo> = new Map();
const DEFAULT_PROVIDER_ROSTER: ReadonlyMap<string, ProviderInfo> = new Map(
  [
    makeProviderInfo({ id: "codex", displayName: "Codex" }),
    makeProviderInfo({ id: "claude-code", displayName: "Claude Code" }),
    makeProviderInfo({ id: "acp-cursor", displayName: "Cursor" }),
  ].map((provider) => [provider.id, provider]),
);

function render(props: Partial<Parameters<typeof SkillsOverview>[0]>): string {
  return renderToStaticMarkup(
    <SkillsOverview
      providerRoster={props.providerRoster ?? DEFAULT_PROVIDER_ROSTER}
      skills={props.skills ?? []}
      isLoading={props.isLoading ?? false}
      hasError={props.hasError ?? false}
      onCreateSkill={props.onCreateSkill ?? (() => {})}
      onSelectSkill={props.onSelectSkill ?? (() => {})}
      onRetry={props.onRetry}
    />,
  );
}

function renderSkillDetailDialog(
  skill: SkillSummary,
  overrides: Partial<ComponentProps<typeof SkillDetailDialogView>> = {},
) {
  return renderDom(
    <SkillDetailDialogView
      skill={skill}
      providerRoster={DEFAULT_PROVIDER_ROSTER}
      files={["SKILL.md"]}
      selectedPath="SKILL.md"
      onSelectPath={() => {}}
      content={`# ${skill.name}`}
      isLoadingContent={false}
      isContentError={false}
      canEdit={false}
      canDelete={false}
      canOpenInEditor={false}
      isDeleting={false}
      onEdit={() => {}}
      onRetry={() => {}}
      onDelete={() => {}}
      onOpenInEditor={() => {}}
      {...overrides}
    />,
  );
}

describe("SkillsOverview", () => {
  it("shows skills from every provider by default with SANDY Official skills first", () => {
    const markup = render({
      skills: [
        makeSkill({ name: "claude-skill", provider: "claude-code" }),
        makeSkill({
          name: "aa-user-skill",
          provider: null,
          scope: "sandy-user",
        }),
        makeSkill({
          name: "zz-official-skill",
          provider: null,
          scope: "sandy-builtin",
          manageable: false,
        }),
      ],
    });
    expect(markup).toContain("claude-skill");
    expect(markup).toContain("Review the current diff.");
    expect(markup).toContain('aria-label="Filters"');
    expect(markup).toContain("Sort");
    expect(markup).not.toContain('role="tab"');
    expect(markup).toContain("SANDY Official");
    expect(markup).toContain("New sandy skill");
    expect(markup).not.toContain('aria-label="Open zz-official-skill"');
    expect(markup.indexOf("zz-official-skill")).toBeLessThan(
      markup.indexOf("aa-user-skill"),
    );
    expect(markup.indexOf("aa-user-skill")).toBeLessThan(
      markup.indexOf("claude-skill"),
    );
  });

  it("labels the Type filter and preserves independent source toggles", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "sandy-builtin",
            manageable: false,
          }),
          makeSkill({
            name: "automations",
            provider: null,
            scope: "plugin",
            pluginId: "automations",
            manageable: false,
          }),
          makeSkill({
            name: "user-skill",
            provider: null,
            scope: "sandy-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    expect(screen.getByText("official-skill")).toBeTruthy();
    expect(screen.getByText("user-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();
    const typeTrigger = screen.getByRole("button", { name: /^Filters/ });
    focusWithKeyboard(typeTrigger);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Filters: All",
    );
    fireEvent.blur(typeTrigger);
    fireEvent.pointerDown(typeTrigger);
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: "All" })).toBeNull();
    for (const name of ["SANDY Official", "Included in plugin", "User"]) {
      expect(
        screen
          .getByRole("menuitemcheckbox", { name })
          .getAttribute("aria-checked"),
      ).toBe("false");
    }
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );

    expect(await screen.findByText("automations")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "automations is included with Automations (sandy plugin)",
      ).textContent,
    ).toBe("Included");
    expect(screen.queryByText("official-skill")).toBeNull();
    expect(screen.queryByText("user-skill")).toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    expect(await screen.findByText("user-skill")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );
    expect(await screen.findByText("official-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();
  });

  it("puts every non-builtin, non-plugin scope in the User bucket", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "claude-authored",
            provider: "claude-code",
            scope: "provider-user",
          }),
          makeSkill({
            name: "codex-authored",
            provider: "codex",
            scope: "provider-project",
          }),
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "sandy-builtin",
            manageable: false,
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Filters/ });
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));

    expect(await screen.findByText("claude-authored")).toBeTruthy();
    expect(screen.getByText("codex-authored")).toBeTruthy();
    expect(screen.queryByText("official-skill")).toBeNull();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Claude Code" }),
    );
    expect(await screen.findByText("claude-authored")).toBeTruthy();
    expect(screen.queryByText("codex-authored")).toBeNull();
    expect(screen.queryByText("official-skill")).toBeNull();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    expect(await screen.findByText("claude-authored")).toBeTruthy();
    expect(screen.queryByText("codex-authored")).toBeNull();
  });

  it("toggles SANDY Official independently from Included in plugin", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "sandy-builtin",
            manageable: false,
          }),
          makeSkill({
            name: "automations",
            provider: null,
            scope: "plugin",
            pluginId: "automations",
            manageable: false,
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );

    expect(await screen.findByText("automations")).toBeTruthy();
    expect(screen.queryByText("official-skill")).toBeNull();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "SANDY Official" }),
    );
    expect(await screen.findByText("official-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "SANDY Official" }),
    );
    expect(await screen.findByText("official-skill")).toBeTruthy();
    expect(screen.getByText("automations")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: /^Filters/ })).toBeTruthy();
  });

  it("uses filter-neutral copy when a Type selection removes every skill", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "official-skill",
            provider: null,
            scope: "sandy-builtin",
            manageable: false,
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Included in plugin" }),
    );

    expect(
      await screen.findByText("No skills match these filters."),
    ).toBeTruthy();
    expect(screen.queryByText("No skills match these providers.")).toBeNull();
  });

  it("names custom ACP agents from the provider roster", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={
          new Map([
            [
              "acp-foo",
              makeProviderInfo({ id: "acp-foo", displayName: "Foo Agent" }),
            ],
            [
              "acp-bar",
              makeProviderInfo({ id: "acp-bar", displayName: "Bar Agent" }),
            ],
          ])
        }
        skills={[
          makeSkill({
            name: "foo-skill",
            description: null,
            provider: "acp-foo",
            scope: "provider-user",
          }),
          makeSkill({
            name: "bar-skill",
            description: null,
            provider: "acp-bar",
            scope: "provider-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemcheckbox", { name: "Foo Agent" }),
      ).not.toBeNull();
    });
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Bar Agent" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "ACP provider" }),
    ).toBeNull();
  });

  it("lists a provider filter only for providers present in the skills", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "codex-skill",
            provider: "codex",
            scope: "provider-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemcheckbox", { name: "Codex" }),
      ).not.toBeNull();
    });
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Claude Code" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Codex" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Codex" })
        .querySelector("[data-provider-logo]"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "sandy" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("shows provider skills when the library has no sandy skills", async () => {
    renderDom(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          makeSkill({
            name: "codex-skill",
            provider: "codex",
            scope: "provider-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    expect(screen.getByText("codex-skill")).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "sandy" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("preserves a user-selected provider filter across library refreshes", async () => {
    const initialSkills = [
      makeSkill({
        id: `skill_${"b".repeat(64)}`,
        name: "sandy-skill",
        provider: null,
        scope: "sandy-user",
      }),
      makeSkill({ name: "claude-skill", provider: "claude-code" }),
    ];
    const view = renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={initialSkills}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Claude Code" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByText("claude-skill")).toBeTruthy();
      expect(screen.queryByText("sandy-skill")).toBeNull();
      expect(
        screen.getByRole("button", { name: /Provider: Claude Code/ }),
      ).toBeTruthy();
    });

    view.rerender(
      <SkillsOverview
        providerRoster={NO_PROVIDER_ROSTER}
        skills={[
          ...initialSkills,
          makeSkill({
            id: `skill_${"c".repeat(64)}`,
            name: "new-sandy-skill",
            provider: null,
            scope: "sandy-user",
          }),
        ]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
      />,
    );

    expect(screen.getByText("claude-skill")).toBeTruthy();
    expect(screen.queryByText("new-sandy-skill")).toBeNull();
  });

  it("keeps edit and delete actions in detail rather than overview rows", () => {
    const markup = render({
      skills: [
        makeSkill({
          name: "sandy-skill",
          provider: null,
          scope: "sandy-user",
          manageable: true,
        }),
        makeSkill({ name: "provider-skill" }),
      ],
    });
    expect(markup).not.toContain('aria-label="Edit sandy-skill"');
    expect(markup).not.toContain('aria-label="Delete sandy-skill"');
    expect(markup).not.toContain('aria-label="Edit provider-skill"');
    expect(markup).not.toContain('aria-label="Delete provider-skill"');
  });

  it("waits for hover intent before warming a row's detail queries", () => {
    vi.useFakeTimers();
    try {
      const onPrefetchSkill = vi.fn();
      renderDom(
        <SkillsOverview
          providerRoster={NO_PROVIDER_ROSTER}
          skills={[makeSkill({ provider: null, scope: "sandy-user" })]}
          isLoading={false}
          hasError={false}
          onCreateSkill={() => {}}
          onSelectSkill={() => {}}
          onPrefetchSkill={onPrefetchSkill}
        />,
      );
      const row = screen.getByRole("button", { name: "code-review" });
      fireEvent.focus(row);
      vi.advanceTimersByTime(100);
      fireEvent.blur(row);
      vi.advanceTimersByTime(1_000);
      expect(onPrefetchSkill).not.toHaveBeenCalled();

      fireEvent.focus(row);
      vi.advanceTimersByTime(150);
      expect(onPrefetchSkill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SkillsLibrary library detail routing", () => {
  it("keeps a detail loading state while the skill library resolves", () => {
    vi.spyOn(sdk.skills, "list").mockImplementation(
      () => new Promise(() => {}),
    );

    renderLibrarySkillRoute();

    expect(screen.getByText("Loading skill")).toBeTruthy();
    expect(screen.queryByText("New sandy skill")).toBeNull();
  });

  it("shows a retryable detail error when the skill library fails to load", async () => {
    vi.spyOn(sdk.skills, "list").mockRejectedValue(
      new Error("skills unavailable"),
    );

    renderLibrarySkillRoute();

    expect(await screen.findByText("Couldn't load skill.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("New sandy skill")).toBeNull();
  });

  it("shows not found on an unknown library skill detail route", async () => {
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [] });

    const fetchMock = renderLibrarySkillRoute();

    const notFound = await screen.findByText("Skill not found.");
    expect(notFound.closest("[data-resource-detail-state]")).not.toBeNull();
    expect(screen.queryByText("New sandy skill")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SkillDetailDialogView", () => {
  it("presents a built-in skill as SANDY Official without an actions menu", async () => {
    const skill = makeSkill({
      name: "sandy-cli",
      provider: null,
      scope: "sandy-builtin",
      manageable: false,
    });
    renderSkillDetailDialog(skill);

    const official = screen.getByLabelText("sandy-cli is SANDY Official");
    expect(official.textContent).toBe("SANDY Official");
    expect(screen.queryByRole("button", { name: "sandy-cli actions" })).toBeNull();
    fireEvent.pointerMove(official);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Ships with sandy",
    );
  });

  it.each([
    {
      skill: makeSkill({
        name: "documents",
        provider: "codex",
        scope: "plugin",
        pluginId: "documents",
        manageable: false,
      }),
      accessibleLabel: "documents is included with Documents (Codex plugin)",
      tooltipName: "Documents plugin.",
      providerIcon: "codex",
    },
    {
      skill: makeSkill({
        name: "plugin-notes",
        provider: null,
        scope: "plugin",
        pluginId: "skill-catalog-fixture",
        manageable: false,
      }),
      accessibleLabel:
        "plugin-notes is included with Skill catalog fixture (sandy plugin)",
      tooltipName: "Skill catalog fixture plugin.",
      providerIcon: "sandy",
    },
  ])("presents $skill.name as plugin-provided", async (example) => {
    renderSkillDetailDialog(example.skill);

    const included = screen.getByLabelText(example.accessibleLabel);
    expect(included.textContent).toBe("Included");
    expect(
      screen.queryByRole("button", { name: `${example.skill.name} actions` }),
    ).toBeNull();
    fireEvent.pointerMove(included);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Included with");
    expect(tooltip.textContent).toContain(example.tooltipName);
    const providerIcon = tooltip.querySelector(
      `[data-provider-icon="${example.providerIcon}"]`,
    );
    expect(providerIcon).not.toBeNull();
    expect(
      ["flex", "size-3.5", "shrink-0", "items-center", "justify-center"].every(
        (className) => providerIcon?.classList.contains(className),
      ),
    ).toBe(true);
  });

  it("labels externally discovered provider skills as imported", async () => {
    const skill = makeSkill({
      name: "code-review",
      provider: "claude-code",
      scope: "provider-user",
      manageable: true,
    });
    renderSkillDetailDialog(skill, { canEdit: true, canDelete: true });

    const imported = screen.getByLabelText(
      "code-review is imported from Claude Code",
    );
    expect(imported.textContent).toBe("Imported");
    fireEvent.pointerMove(imported);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Discovered from");
    expect(tooltip.textContent).toContain("Claude Code");
    expect(
      tooltip.querySelector('[data-provider-icon="claude-code"]'),
    ).not.toBeNull();
  });

  it("uses a hoverable copy target and delegates editing to the thread flow", () => {
    const skill = makeSkill({
      name: "sandy-skill",
      provider: null,
      scope: "sandy-user",
      manageable: true,
      filePath: "/home/u/.sandy/skills/sandy-skill/SKILL.md",
    });
    const onEdit = vi.fn();
    renderSkillDetailDialog(skill, {
      canEdit: true,
      canDelete: true,
      onEdit,
    });

    screen.getByRole("button", {
      name: "Copy skill path: /home/u/.sandy/skills/sandy-skill",
    });
    expect(screen.getByText("~/.sandy/skills/sandy-skill")).toBeTruthy();
    expect(screen.queryByText("SANDY Official", { exact: true })).toBeNull();
    expect(screen.queryByText("Included", { exact: true })).toBeNull();
    expect(screen.queryByText("Imported", { exact: true })).toBeNull();
    expect(screen.queryByText("Editable", { exact: true })).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "sandy-skill actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "Edit SKILL.md" })).toBeNull();
  });
});

describe("SkillDetailView source link", () => {
  it("links to the source and omits social proof", () => {
    renderDom(
      <SkillDetailView
        leading={<span>Skill</span>}
        title="find-skills"
        path="example.com/skills/find-skills"
        pathHref="https://www.example.com/skills/find-skills"
        files={["SKILL.md"]}
        selectedPath="SKILL.md"
        onSelectFile={() => {}}
        contentState={{ kind: "ready", content: "# Find skills" }}
      />,
    );

    const sourceLink = screen.getByRole("link", {
      name: "Open example.com/skills/find-skills in a new tab",
    });
    expect(sourceLink.getAttribute("href")).toBe(
      "https://www.example.com/skills/find-skills",
    );
    expect(sourceLink.getAttribute("target")).toBe("_blank");
    expect(sourceLink.textContent).not.toContain("/SKILL.md");
    expect(screen.queryByText("Registry social proof")).toBeNull();
    expect(
      screen
        .getByRole("heading", { name: "Find skills" })
        .closest(".overflow-auto"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });
});
