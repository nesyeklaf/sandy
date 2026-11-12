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
import type {
  SkillSelectionProvider,
  SkillSummary,
} from "@sandy/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeProviderInfo } from "@sandy/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";
import { SkillDetailView } from "../components/tools/SkillDetailView";
import {
  SkillDetailDialogView,
  SkillsOverview,
  skillSelectionModeText,
  skillSelectionStatusText,
} from "../components/tools/SkillsCollection";
import { SkillsLibrary } from "../components/tools/SkillsLibrary";
import { appToast } from "@/components/ui/app-toast";
import type { SkillSelection } from "@sandy/domain";
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
    writable: true,
    metadata: {},
    revision: null,
    providers: provider === null ? [] : [provider],
    duplicates: [],
    selectionEnabled: true,
    ...overrides,
  };
}

function renderLibrarySkillRoute() {
  vi.spyOn(sdk.providers, "list").mockResolvedValue([]);
  vi.spyOn(sdk.hosts, "list").mockResolvedValue([]);
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
      selectionProviders={props.selectionProviders}
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
      isSelectionPending={false}
      onSelectionChange={() => {}}
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

describe("skill selection on the Skills page", () => {
  const codex: SkillSelectionProvider = {
    providerId: "codex",
    displayName: "Codex",
    support: { session: "enforced", subagents: "enforced", gaps: [] },
  };
  const claude: SkillSelectionProvider = {
    providerId: "claude-code",
    displayName: "Claude Code",
    support: {
      session: "unverified",
      subagents: "unverified",
      gaps: ["bundled-skills", "marketplace-plugin-skills"],
    },
  };
  const legacy: SkillSelectionProvider = {
    providerId: "legacy",
    displayName: "Legacy",
    support: { session: "not-enforced", subagents: "not-enforced", gaps: [] },
  };

  it("marks only turned-off skills with an Off chip in overview rows", () => {
    const markup = render({
      skills: [
        makeSkill({ id: `skill_${"b".repeat(64)}`, name: "kept" }),
        makeSkill({
          id: `skill_${"c".repeat(64)}`,
          name: "dropped",
          selectionEnabled: false,
        }),
      ],
    });
    expect(markup).toContain('aria-label="dropped is turned off for agents"');
    expect(markup).not.toContain('aria-label="kept is turned off for agents"');
  });

  it("keeps the Off chip outside the truncating title so a long name cannot clip it", () => {
    const container = document.createElement("div");
    container.innerHTML = render({
      skills: [
        makeSkill({
          name: "claude-code-provider-with-a-very-long-name",
          scope: "plugin",
          provider: "claude-code",
          selectionEnabled: false,
        }),
      ],
    });
    const chip = container.querySelector(
      '[aria-label="claude-code-provider-with-a-very-long-name is turned off for agents"]',
    );
    expect(chip).not.toBeNull();
    const holder = chip?.closest("[data-skill-selection-off]");
    expect(holder?.classList.contains("shrink-0")).toBe(true);
    let ancestor = chip?.parentElement ?? null;
    while (ancestor !== null && ancestor !== container) {
      expect(ancestor.classList.contains("truncate")).toBe(false);
      ancestor = ancestor.parentElement;
    }
    expect(container.textContent).toContain("Included");
  });

  it("states which providers apply the selection and which still load every skill", () => {
    const skills = [
      makeSkill({ name: "dropped", selectionEnabled: false }),
      makeSkill({
        id: `skill_${"d".repeat(64)}`,
        name: "dropped",
        selectionEnabled: false,
      }),
      makeSkill({ id: `skill_${"e".repeat(64)}`, name: "kept" }),
    ];
    expect(skillSelectionStatusText(skills, [codex, claude, legacy])).toBe(
      "1 skill is off. New Codex sessions start without it. Claude Code leaves it out of new sessions, not yet proven against the real agent. Legacy still loads every skill. Not filtered: skills bundled with the agent and skills from the agent's own plugins (Claude Code). Subagents of Claude Code may still load it.",
    );
    expect(skillSelectionStatusText(skills, [codex])).toBe(
      "1 skill is off. New Codex sessions start without it.",
    );
    expect(
      skillSelectionStatusText([makeSkill({ name: "kept" })], [codex, legacy]),
    ).toBeNull();
  });

  it("shows the selection status in the overview description", () => {
    const markup = render({
      skills: [makeSkill({ name: "dropped", selectionEnabled: false })],
      selectionProviders: [legacy],
    });
    expect(markup).toContain("1 skill is off.");
    expect(markup).toContain("Legacy still loads every skill.");
  });

  it("reflects the selection in the detail switch and reports the requested state", () => {
    const onSelectionChange = vi.fn();
    renderSkillDetailDialog(makeSkill({ selectionEnabled: false }), {
      onSelectionChange,
    });
    const toggle = screen.getByRole("switch", {
      name: "Turn on code-review for agents",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onSelectionChange).toHaveBeenCalledWith(true);
  });

  it("lists the other copies of a name on the skill page by their literal paths", () => {
    const cursorPath = "/home/u/.claude/skills/code-review/SKILL.md";
    const piPath = "/home/u/.pi/agent/skills/code-review/SKILL.md";
    renderSkillDetailDialog(
      makeSkill({
        filePath: "/home/u/.agents/skills/code-review/SKILL.md",
        duplicates: [
          {
            id: "skill_" + "1".repeat(64),
            scope: "provider-user",
            provider: "acp-cursor",
            pluginId: null,
            filePath: cursorPath,
            relation: "same-name",
          },
          {
            id: "skill_" + "2".repeat(64),
            scope: "provider-user",
            provider: "omp",
            pluginId: null,
            filePath: piPath,
            relation: "same-content",
          },
        ],
      }),
    );
    expect(screen.getByRole("heading", { name: "Other copies" })).toBeTruthy();
    const origins = document.querySelector("[data-skill-duplicate-origins]");
    expect(origins?.textContent).toBe(
      "Same name" + cursorPath + "Same content" + piPath,
    );
  });

  it("lets the provenance and duplicate pills shrink inside a narrow title", () => {
    const container = document.createElement("div");
    container.innerHTML = render({
      skills: [
        makeSkill({
          name: "claude-code-provider",
          scope: "plugin",
          selectionEnabled: false,
          duplicates: [
            {
              id: "skill_" + "3".repeat(64),
              scope: "provider-user",
              provider: "codex",
              pluginId: null,
              filePath: "/home/u/.agents/skills/claude-code-provider/SKILL.md",
              relation: "same-name",
            },
          ],
        }),
      ],
    });
    const pills = [
      container.querySelector('[aria-label^="claude-code-provider is included with"]'),
      container.querySelector('[aria-label^="claude-code-provider is also found at"]'),
    ];
    for (const pill of pills) {
      expect(pill?.classList.contains("min-w-0")).toBe(true);
      expect(pill?.classList.contains("max-w-full")).toBe(true);
    }
    expect(
      pills[0]?.parentElement?.classList.contains("min-w-0"),
    ).toBe(true);
  });

  it("disables the detail switch while the selection is pending", () => {
    renderSkillDetailDialog(makeSkill(), { isSelectionPending: true });
    const toggle = screen.getByRole("switch", {
      name: "Turn off code-review for agents",
    });
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });

  function renderSelectableOverview({
    skills,
    selection,
    query,
  }: {
    skills: SkillSummary[];
    selection: SkillSelection;
    query?: string;
  }) {
    const onChange = vi.fn();
    renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={skills}
        isLoading={false}
        hasError={false}
        query={query}
        onCreateSkill={() => {}}
        onSelectSkill={() => {}}
        selectionControl={{ selection, isPending: false, onChange }}
      />,
    );
    return onChange;
  }

  it("turns one skill off from its overview row without opening it", () => {
    const onSelectSkill = vi.fn();
    const onChange = vi.fn();
    renderDom(
      <SkillsOverview
        providerRoster={DEFAULT_PROVIDER_ROSTER}
        skills={[makeSkill()]}
        isLoading={false}
        hasError={false}
        onCreateSkill={() => {}}
        onSelectSkill={onSelectSkill}
        selectionControl={{
          selection: { mode: "inherit" },
          isPending: false,
          onChange,
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Turn off code-review for agents" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      mode: "disable",
      names: ["code-review"],
    });
    expect(onSelectSkill).not.toHaveBeenCalled();
  });

  it("shows one name-level state on every copy of a duplicated name", () => {
    const claudeId = `skill_${"f".repeat(64)}`;
    const claudePath = "/home/u/.claude/skills/code-review/SKILL.md";
    const agentsId = `skill_${"9".repeat(64)}`;
    const agentsPath = "/home/u/.agents/skills/code-review/SKILL.md";
    const onChange = renderSelectableOverview({
      skills: [
        makeSkill({
          id: claudeId,
          filePath: claudePath,
          selectionEnabled: false,
          duplicates: [
            {
              id: agentsId,
              scope: "provider-user",
              provider: "codex",
              pluginId: null,
              filePath: agentsPath,
              relation: "same-name",
            },
          ],
        }),
        makeSkill({
          id: agentsId,
          provider: "codex",
          filePath: agentsPath,
          selectionEnabled: false,
          duplicates: [
            {
              id: claudeId,
              scope: "provider-user",
              provider: "claude-code",
              pluginId: null,
              filePath: claudePath,
              relation: "same-name",
            },
          ],
        }),
      ],
      selection: { mode: "disable", names: ["code-review"] },
    });
    const switches = screen.getAllByRole("switch", {
      name: "Turn on code-review for agents, with 1 other copy of the same name",
    });
    expect(switches).toHaveLength(2);
    expect(
      switches.map((toggle) => toggle.getAttribute("aria-checked")),
    ).toEqual(["false", "false"]);
    expect(
      screen.getByLabelText(`code-review is also found at ${claudePath}`),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(`code-review is also found at ${agentsPath}`),
    ).toBeTruthy();
    fireEvent.click(switches[1]!);
    expect(onChange).toHaveBeenCalledWith({ mode: "disable", names: [] });
  });

  it("turns every skill off, keeps only the shown skills on, and resets from the selection menu", () => {
    const skills = [
      makeSkill({ id: `skill_${"1".repeat(64)}`, name: "review-diff" }),
      makeSkill({ id: `skill_${"2".repeat(64)}`, name: "review-plan" }),
      makeSkill({
        id: `skill_${"3".repeat(64)}`,
        name: "deploy",
        description: "Ship the current build.",
      }),
    ];
    const onChange = renderSelectableOverview({
      skills,
      selection: { mode: "disable", names: ["deploy"] },
      query: "review",
    });
    expect(screen.queryByRole("button", { name: "deploy" })).toBeNull();
    const openMenu = () =>
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Skill selection" }),
      );

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Turn all skills off" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "allow-only",
      names: [],
    });

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Only the 2 shown skills on" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "allow-only",
      names: ["review-diff", "review-plan"],
    });

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Turn the 2 shown skills off" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "disable",
      names: ["deploy", "review-diff", "review-plan"],
    });

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Turn every skill on" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ mode: "inherit" });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("turns a skill back on under all-off by adding it to the allow-only list", () => {
    const onChange = renderSelectableOverview({
      skills: [makeSkill({ selectionEnabled: false })],
      selection: { mode: "allow-only", names: [] },
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Turn on code-review for agents" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      mode: "allow-only",
      names: ["code-review"],
    });
  });

  it("names allow-only mode so skills added later are known to start off", () => {
    expect(skillSelectionModeText({ mode: "inherit" })).toBeNull();
    expect(
      skillSelectionModeText({ mode: "disable", names: ["code-review"] }),
    ).toBeNull();
    expect(skillSelectionModeText({ mode: "allow-only", names: [] })).toBe(
      "The selection turns every skill off for agents, including skills added later. Agents still load the skills they cannot filter, listed in the provider status.",
    );
    expect(
      skillSelectionModeText({
        mode: "allow-only",
        names: ["code-review", "deploy"],
      }),
    ).toBe(
      "Only 2 chosen skills are on for agents. Every other skill, including skills added later, stays off until you turn it on. Agents still load the skills they cannot filter, listed in the provider status.",
    );
    renderSelectableOverview({
      skills: [makeSkill()],
      selection: { mode: "allow-only", names: ["code-review"] },
    });
    expect(
      screen.getByText(
        "Only 1 chosen skill is on for agents. Every other skill, including skills added later, stays off until you turn it on. Agents still load the skills they cannot filter, listed in the provider status.",
      ),
    ).toBeTruthy();
  });

  it("states when a change applies and that the selection is not a security boundary", () => {
    renderSelectableOverview({
      skills: [makeSkill()],
      selection: { mode: "inherit" },
    });
    const note = screen.getByText(/applies to agent sessions that start afterwards/);
    expect(note.textContent).toContain(
      "threads already loaded keep the skills they started with until stopped or their idle session is retired",
    );
    expect(note.textContent).toContain(
      "an agent with file access can still open a skill's file",
    );
  });

  it("offers the existing thread stop for running threads after a change", async () => {
    const skill = makeSkill({ id: "skill_missing", name: "code-review" });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [skill] });
    vi.spyOn(sdk.skills, "listFiles").mockResolvedValue({
      files: ["SKILL.md"],
      truncated: false,
    });
    vi.spyOn(sdk.skills, "getContent").mockResolvedValue({
      content: "# code-review",
      revision: "a".repeat(64),
      filePath: skill.filePath,
      writable: true,
    });
    vi.spyOn(sdk.skills, "experimental_getSelection").mockResolvedValue({
      selection: { mode: "inherit" },
      providers: [codex],
    });
    vi.spyOn(sdk.skills, "experimental_setSelection").mockResolvedValue({
      selection: { mode: "disable", names: ["code-review"] },
      providers: [codex],
      pendingThreadIds: ["thr_running"],
    });
    const stop = vi.spyOn(sdk.threads, "stop").mockResolvedValue({ ok: true });
    const toast = vi
      .spyOn(appToast, "message")
      .mockImplementation(() => "toast");

    renderLibrarySkillRoute();

    const toggle = await screen.findByRole("switch", {
      name: "Turn off code-review for agents",
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const [, options] = toast.mock.calls[0]!;
    expect(options?.description).toContain(
      "1 running thread keeps the previous skills until stopped.",
    );
    const action = options?.action;
    expect(action?.label).toBe("Stop thread");
    expect(stop).not.toHaveBeenCalled();
    renderDom(
      <button type="button" onClick={action?.onClick}>
        {action?.label}
      </button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop thread" }));
    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith({ threadId: "thr_running" }),
    );
  });

  it("sends the shared selection mutation from the library detail switch", async () => {
    const skill = makeSkill({ id: "skill_missing", name: "code-review" });
    vi.spyOn(sdk.skills, "list").mockResolvedValue({ skills: [skill] });
    vi.spyOn(sdk.skills, "listFiles").mockResolvedValue({
      files: ["SKILL.md"],
      truncated: false,
    });
    vi.spyOn(sdk.skills, "getContent").mockResolvedValue({
      content: "# code-review",
      revision: "a".repeat(64),
      filePath: skill.filePath,
      writable: true,
    });
    vi.spyOn(sdk.skills, "experimental_getSelection").mockResolvedValue({
      selection: { mode: "disable", names: ["other-skill"] },
      providers: [codex],
    });
    const setSelection = vi
      .spyOn(sdk.skills, "experimental_setSelection")
      .mockResolvedValue({
        selection: { mode: "disable", names: ["code-review", "other-skill"] },
        providers: [codex],
        pendingThreadIds: [],
      });

    renderLibrarySkillRoute();

    const toggle = await screen.findByRole("switch", {
      name: "Turn off code-review for agents",
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(setSelection).toHaveBeenCalledWith({
        mode: "disable",
        names: ["code-review", "other-skill"],
      }),
    );
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
