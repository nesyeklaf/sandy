import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import {
  builtInThemes,
  defaultAppTheme,
  defaultFaviconColor,
  faviconColorPreferenceSchema,
  FAVICON_COLORS,
  isBuiltInThemeId,
  type AppTheme,
  type ThemeIssue,
  type ThemeKitInput,
  type FaviconColorPreference,
} from "@sandy/domain";
import { action } from "../action.js";
import { createCliSandySdk } from "../client.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

interface ThemeShowCommandOptions extends JsonOutputOptions {
  css?: boolean;
}

interface ThemeSetCommandOptions extends JsonOutputOptions {
  faviconColor?: string;
}

function parseFaviconColor(value: string): FaviconColorPreference {
  const parsed = faviconColorPreferenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid favicon color '${value}'. Expected one of: default, ${FAVICON_COLORS.join(
        ", ",
      )}.`,
    );
  }
  return parsed.data;
}

interface ThemeNewCommandOptions extends JsonOutputOptions {
  lightCanvas: string;
  lightInk: string;
  lightAccent: string;
  darkCanvas: string;
  darkInk: string;
  darkAccent: string;
  statusChroma?: string;
  fontSans?: string;
  fontMono?: string;
  fontTerminal?: string;
  overwrite?: boolean;
  set?: boolean;
}

function themeKitFromOptions(opts: ThemeNewCommandOptions): ThemeKitInput {
  const fonts = {
    ...(opts.fontSans === undefined ? {} : { sans: opts.fontSans }),
    ...(opts.fontMono === undefined ? {} : { mono: opts.fontMono }),
    ...(opts.fontTerminal === undefined ? {} : { terminal: opts.fontTerminal }),
  };
  const statusChroma =
    opts.statusChroma === undefined ? undefined : Number(opts.statusChroma);
  if (statusChroma !== undefined && !Number.isFinite(statusChroma)) {
    throw new Error(`Invalid --status-chroma '${opts.statusChroma}'.`);
  }
  return {
    light: {
      canvas: opts.lightCanvas,
      ink: opts.lightInk,
      accent: opts.lightAccent,
    },
    dark: {
      canvas: opts.darkCanvas,
      ink: opts.darkInk,
      accent: opts.darkAccent,
    },
    ...(statusChroma === undefined ? {} : { statusChroma }),
    ...(Object.keys(fonts).length === 0 ? {} : { fonts }),
  };
}

function printIssues(issues: readonly ThemeIssue[]): void {
  if (issues.length === 0) {
    console.log("No findings: contrast, coverage and comfort checks pass.");
    return;
  }
  for (const issue of issues) {
    console.log(
      `${issue.severity.padEnd(7)} ${issue.mode.padEnd(5)} --${issue.token}: ${issue.message}`,
    );
  }
}

function describeTheme(theme: AppTheme): string {
  if (!isBuiltInThemeId(theme.themeId)) {
    const bytes = theme.customCss?.length ?? 0;
    return `Custom theme '${theme.themeId}' (${bytes} bytes)`;
  }
  const meta = builtInThemes.find((entry) => entry.id === theme.themeId);
  return meta ? `${meta.name} (${meta.id})` : theme.themeId;
}

function describeCodeTheme(theme: AppTheme): string {
  const { dark, light } = theme.resolvedCodeTheme;
  return dark === light ? dark : `${dark} / ${light}`;
}

export function registerThemeCommands(
  program: Command,
  getUrl: () => string,
): void {
  const theme = program
    .command("theme")
    .description("Manage the app theme and favicon color");

  theme
    .command("list")
    .description("List built-in and custom themes and the active palette")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const catalog = await sdk.theme.catalog();
        if (
          outputJson(opts, {
            active: catalog.active,
            builtInThemes,
            custom: catalog.custom,
            plugins: catalog.plugins,
            dir: catalog.dir,
          })
        ) {
          return;
        }
        const active = catalog.active.themeId;
        console.log("");
        console.log("Built-in:");
        for (const entry of builtInThemes) {
          const marker = active === entry.id ? "*" : " ";
          console.log(`${marker} ${entry.id.padEnd(12)} ${entry.description}`);
        }
        console.log("");
        console.log(`Custom (${catalog.dir}):`);
        if (catalog.custom.length === 0) {
          console.log(
            `  (none — create <name>/theme.css under that directory)`,
          );
        } else {
          for (const name of catalog.custom) {
            const marker = active === name ? "*" : " ";
            console.log(`${marker} ${name}`);
          }
        }
        console.log("");
        console.log("Plugins:");
        if (catalog.plugins.length === 0) console.log("  (none)");
        for (const entry of catalog.plugins) {
          const marker = active === entry.id ? "*" : " ";
          console.log(`${marker} ${entry.id.padEnd(24)} ${entry.name}`);
        }
        console.log("");
        console.log(`Active: ${describeTheme(catalog.active)}`);
        console.log(`Favicon color: ${catalog.active.faviconColor}`);
        console.log(`Code theme: ${describeCodeTheme(catalog.active)}`);
      }),
    );

  theme
    .command("set <id>")
    .description(
      "Switch to a built-in, custom, or plugin-contributed theme by id",
    )
    .option(
      "--favicon-color <color>",
      "Set the favicon color in the same appearance update",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ThemeSetCommandOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const updated =
          opts.faviconColor === undefined
            ? await sdk.theme.set(id)
            : await sdk.theme.set({
                themeId: id,
                faviconColor: parseFaviconColor(opts.faviconColor),
              });
        if (outputJson(opts, updated)) return;
        console.log(`Theme set to ${describeTheme(updated)}`);
      }),
    );

  theme
    .command("new <name>")
    .description(
      "Generate a full custom theme from canvas, ink and accent colors per mode, check it, and write it to the custom theme directory",
    )
    .requiredOption("--light-canvas <color>", "Light background, oklch(L C H) or #rrggbb")
    .requiredOption("--light-ink <color>", "Light text color")
    .requiredOption("--light-accent <color>", "Light accent (primary) color")
    .requiredOption("--dark-canvas <color>", "Dark background")
    .requiredOption("--dark-ink <color>", "Dark text color")
    .requiredOption("--dark-accent <color>", "Dark accent (primary) color")
    .option("--status-chroma <number>", "Chroma of status colors, 0 to 0.16 (default 0.085)")
    .option("--font-sans <stack>", "font-sans CSS font stack")
    .option("--font-mono <stack>", "font-mono CSS font stack")
    .option("--font-terminal <stack>", "font-terminal CSS font stack")
    .option("--overwrite", "Replace an existing custom theme of the same name")
    .option("--set", "Activate the theme after writing it")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (name: string, opts: ThemeNewCommandOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const created = await sdk.theme.experimental_create({
          name,
          kit: themeKitFromOptions(opts),
          overwrite: opts.overwrite === true,
        });
        const activated =
          opts.set === true ? await sdk.theme.set(created.name) : null;
        if (outputJson(opts, { ...created, activated })) return;
        console.log(`Wrote ${created.path}`);
        printIssues(created.issues);
        if (activated !== null) {
          console.log(`Theme set to ${describeTheme(activated)}`);
        } else {
          console.log(`Activate it with: sandy theme set ${created.name}`);
        }
      }),
    );

  theme
    .command("check <nameOrFile>")
    .description(
      "Check a custom theme (by name) or a theme.css file for contrast, missing tokens and eye comfort; exits 1 on errors",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (nameOrFile: string, opts: JsonOutputOptions) => {
        const sdk = createCliSandySdk(getUrl());
        let css: string | null;
        if (existsSync(nameOrFile)) {
          css = readFileSync(nameOrFile, "utf8");
        } else {
          css = (await sdk.theme.resolve({ themeId: nameOrFile })).customCss;
          if (css === null) {
            throw new Error(
              `'${nameOrFile}' has no CSS on disk; only custom and plugin themes can be checked.`,
            );
          }
        }
        const issues = sdk.theme.experimental_check(css);
        if (!outputJson(opts, { issues })) printIssues(issues);
        if (issues.some((issue) => issue.severity === "error")) {
          process.exitCode = 1;
        }
      }),
    );

  theme
    .command("dir")
    .description("Print the directory where custom themes live")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const catalog = await sdk.theme.catalog();
        if (outputJson(opts, { dir: catalog.dir })) return;
        console.log(catalog.dir);
      }),
    );

  const favicon = theme
    .command("favicon")
    .description("Manage the app favicon color without changing the theme");

  favicon
    .command("set <color>")
    .description(
      `Set the favicon color (${FAVICON_COLORS.join(", ")}, or default)`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (color: string, opts: JsonOutputOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const active = await sdk.theme.get();
        const updated = await sdk.theme.set({
          themeId: active.themeId,
          faviconColor: parseFaviconColor(color),
        });
        if (outputJson(opts, updated)) return;
        console.log(`Favicon color set to ${updated.faviconColor}`);
      }),
    );

  favicon
    .command("reset")
    .description("Reset the favicon color without changing the theme")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const active = await sdk.theme.get();
        const updated = await sdk.theme.set({
          themeId: active.themeId,
          faviconColor: defaultFaviconColor,
        });
        if (outputJson(opts, updated)) return;
        console.log(`Favicon color reset to ${updated.faviconColor}`);
      }),
    );

  theme
    .command("show [id]")
    .description(
      "Show the active theme, or resolve a theme by id without activating it",
    )
    .option("--css", "Print the theme's CSS (custom and plugin themes only)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThemeShowCommandOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const theme =
          id === undefined
            ? await sdk.theme.get()
            : await sdk.theme.resolve({ themeId: id });
        if (outputJson(opts, theme)) return;
        if (opts.css) {
          if (theme.customCss !== null) {
            console.log(theme.customCss);
          } else {
            console.log(
              "// Built-in theme CSS is bundled in the app, not stored on disk.",
            );
          }
          return;
        }
        if (id === undefined) {
          console.log(`Active: ${describeTheme(theme)}`);
          console.log(`Favicon color: ${theme.faviconColor}`);
        } else {
          console.log(`Theme: ${describeTheme(theme)}`);
        }
        console.log(`Code theme: ${describeCodeTheme(theme)}`);
      }),
    );

  theme
    .command("reset")
    .description("Reset to the Default theme")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliSandySdk(getUrl());
        const updated = await sdk.theme.set(defaultAppTheme.themeId);
        if (outputJson(opts, updated)) return;
        console.log(`Theme reset to ${describeTheme(updated)}`);
      }),
    );
}
