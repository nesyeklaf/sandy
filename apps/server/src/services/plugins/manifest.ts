import { findSkillFiles } from "@sandy/skill-index";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import {
  derivePluginId,
  isCodeThemeFilePath,
  isPluginOwnedIconPath,
  pluginPackageJsonSchema,
  type UiCodeThemeDeclaration,
} from "@sandy/domain";
import { resolvePluginCodeThemePath } from "../system/code-themes.js";
import {
  readPluginPackageJsonFile,
  resolveManifestAssetFile,
  resolveManifestEntryFile,
  resolveManifestPath,
  assertValidPluginCompactIconSvg,
  assertValidPluginIconSvg,
} from "@sandy/plugin-build";

export interface PluginManifest {
  id: string;
  packageName: string;
  version: string;
  name: string;
  description: string;
  branding: {
    icon?: string;
    compactIconPath?: string;
    logo?: {
      lightPath: string;
      darkPath?: string;
    };
    icons: ReadonlyMap<string, string>;
  };
  sandyEngineRange: string | undefined;
  sandyPluginSdkRange: string | undefined;
  providerCatalog: Array<{ id: string; displayName: string }>;
  serverEntry: string;
  appEntry: string | undefined;
  hostEntry: string | undefined;
  themes: Array<{
    id: string;
    name: string;
    description: string | null;
    cssPath: string;
    codeTheme: UiCodeThemeDeclaration | null;
    codeThemePaths: { dark?: string; light?: string };
  }>;
  skillsRootPaths: string[];
  skillNames: string[];
  rootDir: string;
}

async function readSkillNames(rootPaths: string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const rootPath of rootPaths) {
    for (const skill of await findSkillFiles({
      path: rootPath,
      shape: "skill",
      boundaryPath: null,
    })) {
      names.add(skill.name);
    }
  }
  return [...names].sort();
}

export async function readPluginManifest(
  rootDir: string,
): Promise<PluginManifest> {
  const packageJsonPath = join(rootDir, "package.json");
  const json = await readPluginPackageJsonFile(packageJsonPath);
  const parsed = pluginPackageJsonSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new Error(
      `invalid plugin package.json${path ? ` (${path})` : ""}: ${issue?.message ?? "unknown error"}`,
    );
  }
  const { name: packageName, version, engines, sandy } = parsed.data;
  if (
    engines?.sandyPluginSdk !== undefined &&
    semver.validRange(engines.sandyPluginSdk) === null
  ) {
    throw new Error(
      "invalid plugin package.json (engines.sandyPluginSdk): must be a valid semver range",
    );
  }
  const serverEntry = await resolveManifestEntryFile(
    rootDir,
    sandy.server,
    "sandy.server",
  );
  const hostEntry = sandy.host
    ? await resolveManifestEntryFile(rootDir, sandy.host, "sandy.host")
    : undefined;
  const skillsRootPaths = (sandy.skills ?? ["skills"]).map((entry) =>
    resolveManifestPath(rootDir, entry.replace(/\/\*$/, ""), "sandy.skills"),
  );
  const resolveBrandingAsset = (entry: string, label: string): string => {
    if (!/\.(svg|png|webp)$/i.test(entry)) {
      throw new Error(
        `manifest ${label} must point at a .svg, .png, or .webp file, got "${entry}"`,
      );
    }
    return resolveManifestPath(rootDir, entry, label);
  };
  const brandingLogo =
    sandy.branding.logo === undefined
      ? undefined
      : {
          lightPath: resolveBrandingAsset(
            sandy.branding.logo.light,
            "sandy.branding.logo.light",
          ),
          ...(sandy.branding.logo.dark === undefined
            ? {}
            : {
                darkPath: resolveBrandingAsset(
                  sandy.branding.logo.dark,
                  "sandy.branding.logo.dark",
                ),
              }),
        };
  const brandingCompactIconPath =
    sandy.branding.icon !== undefined && isPluginOwnedIconPath(sandy.branding.icon)
      ? resolveBrandingAsset(sandy.branding.icon, "sandy.branding.icon")
      : undefined;
  for (const [label, assetPath] of [
    ["sandy.branding.icon", brandingCompactIconPath],
    ["sandy.branding.logo.light", brandingLogo?.lightPath],
    ["sandy.branding.logo.dark", brandingLogo?.darkPath],
  ] as const) {
    if (assetPath === undefined) continue;
    const realAsset = await resolveManifestAssetFile(rootDir, assetPath, label);
    if (label === "sandy.branding.icon") {
      assertValidPluginCompactIconSvg(await readFile(realAsset), label);
    }
  }
  const brandingIcons = new Map<string, string>();
  for (const [name, entry] of Object.entries(
    sandy.branding.experimental_icons ?? {},
  )) {
    const label = `sandy.branding.experimental_icons["${name}"]`;
    const realAsset = await resolveManifestAssetFile(
      rootDir,
      resolveManifestPath(rootDir, entry, label),
      label,
    );
    assertValidPluginIconSvg(await readFile(realAsset), label);
    brandingIcons.set(name, realAsset);
  }
  const themeIds = new Set<string>();
  const themes = (sandy.themes ?? []).map((theme) => {
    if (themeIds.has(theme.id)) {
      throw new Error(`manifest sandy.themes contains duplicate id "${theme.id}"`);
    }
    themeIds.add(theme.id);
    if (!theme.css.toLowerCase().endsWith(".css")) {
      throw new Error(
        `manifest sandy.themes theme "${theme.id}" must point at a .css file`,
      );
    }
    const codeTheme = theme.codeTheme ?? null;
    const codeThemePaths: { dark?: string; light?: string } = {};
    if (codeTheme?.dark !== undefined && isCodeThemeFilePath(codeTheme.dark)) {
      codeThemePaths.dark = resolvePluginCodeThemePath(
        rootDir,
        theme.id,
        "dark",
        codeTheme.dark,
      );
    }
    if (
      codeTheme?.light !== undefined &&
      isCodeThemeFilePath(codeTheme.light)
    ) {
      codeThemePaths.light = resolvePluginCodeThemePath(
        rootDir,
        theme.id,
        "light",
        codeTheme.light,
      );
    }
    return {
      id: theme.id,
      name: theme.name,
      description: theme.description ?? null,
      cssPath: resolveManifestPath(
        rootDir,
        theme.css,
        `sandy.themes.${theme.id}.css`,
      ),
      codeTheme,
      codeThemePaths,
    };
  });
  for (const theme of themes) {
    try {
      await stat(theme.cssPath);
    } catch {
      throw new Error(
        `manifest sandy.themes theme "${theme.id}" points at a missing file`,
      );
    }
    for (const [side, path] of Object.entries(theme.codeThemePaths)) {
      try {
        await stat(path);
      } catch {
        throw new Error(
          `manifest sandy.themes theme "${theme.id}" codeTheme.${side} points at a missing file`,
        );
      }
    }
  }
  return {
    id: derivePluginId(packageName),
    packageName,
    version,
    name: sandy.name,
    description: sandy.description,
    branding: {
      ...(sandy.branding.icon === undefined ? {} : { icon: sandy.branding.icon }),
      ...(brandingCompactIconPath === undefined
        ? {}
        : { compactIconPath: brandingCompactIconPath }),
      ...(brandingLogo === undefined ? {} : { logo: brandingLogo }),
      icons: brandingIcons,
    },
    sandyEngineRange: engines?.sandy,
    sandyPluginSdkRange: engines?.sandyPluginSdk,
    providerCatalog: (sandy.experimental_providers ?? []).map(
      ({ id, displayName }) => ({ id, displayName }),
    ),
    serverEntry,
    appEntry: sandy.app
      ? resolveManifestPath(rootDir, sandy.app, "sandy.app")
      : undefined,
    hostEntry,
    themes,
    skillsRootPaths,
    skillNames: await readSkillNames(skillsRootPaths),
    rootDir,
  };
}
