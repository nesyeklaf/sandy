import { join } from "node:path";
import {
  MARKETPLACE_OVERVIEW_MAX_CHARS,
  marketplaceEntryV2Schema,
  pluginCatalogCategory,
  pluginMarketplaceCategorySchema,
  pluginMarketplaceCollectionSchema,
  type PluginMarketplaceCategory,
  type PluginMarketplaceCollection,
} from "@sandy/domain";
import {
  pluginMarketplaceNameSchema,
  ROOT_PLUGIN_SOURCE_SELECTION,
  type PluginSourceSelection,
} from "@sandy/server-contract";
import semver from "semver";
import { z } from "zod";
import {
  formatIssues,
  parseJsonDocument,
} from "../plugins/collection-manifest.js";
import {
  gitRangeSourceSpec,
  gitSemverTagName,
  normalizeGitTagPrefix,
  normalizePluginSubdirectory,
  parsePluginSource,
} from "../plugins/install-sources.js";
import { BUNDLED_MARKETPLACE_NAME } from "./bundled-marketplace-paths.js";
export { BUNDLED_MARKETPLACE_NAME } from "./bundled-marketplace-paths.js";

export const BUILTIN_PUBLISHER_LABEL = "SANDY Official";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
const ICON_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const ICON_EXTENSIONS = [".svg", ".png", ".webp"] as const;

const semverRange = z
  .string()
  .min(1)
  .refine((value) => semver.validRange(value) !== null, {
    message: "must be a valid semver range",
  });

const httpsUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "must be an https URL" },
  );

function iconExtensionProblem(pathname: string): string | null {
  const lower = pathname.toLowerCase();
  return ICON_EXTENSIONS.some((extension) => lower.endsWith(extension))
    ? null
    : `must point at a ${ICON_EXTENSIONS.join(", ")} file`;
}

const iconUrlSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
    if (absolute && !value.toLowerCase().startsWith("https:")) {
      ctx.addIssue({ code: "custom", message: "must be an https URL" });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(value, "https://marketplace.invalid/base/").pathname;
    } catch {
      ctx.addIssue({ code: "custom", message: "is not a valid URL" });
      return;
    }
    const problem = iconExtensionProblem(pathname);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

const iconSchema = z.union([
  z.string().regex(ICON_NAME_PATTERN, "must be a host icon name"),
  z.object({ url: iconUrlSchema }).strict(),
]);

const authorSchema = z
  .object({
    name: z.string().min(1),
    github: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
    url: httpsUrl.optional(),
  })
  .strict();

const gitSubdirSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      normalizePluginSubdirectory(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const gitRefSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      const parsed = parsePluginSource(
        `git:https://marketplace.invalid/plugin.git@${value}`,
      );
      if (
        parsed.kind !== "git" ||
        parsed.selector.kind !== "ref" ||
        parsed.selector.ref !== value
      ) {
        throw new Error("git ref is ambiguous");
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const gitTagPrefixSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      normalizeGitTagPrefix(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const gitSourceSchema = z.union([
  z
    .object({
      git: z
        .object({
          url: httpsUrl,
          subdir: gitSubdirSchema.optional(),
          ref: gitRefSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      git: z
        .object({
          url: httpsUrl,
          subdir: gitSubdirSchema.optional(),
          range: semverRange,
          tagPrefix: gitTagPrefixSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);

const marketplaceEntryV1Schema = z
  .object({
    id: z.string().regex(NAME_PATTERN),
    displayName: z.string().min(1),
    description: z.string().min(1),
    icon: iconSchema,
    tags: z.array(z.string().max(32).regex(TAG_PATTERN)).max(10).optional(),
    author: authorSchema,
    source: gitSourceSchema,
  })
  .strict();

const marketplaceManifestV1Schema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1),
    name: pluginMarketplaceNameSchema,
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
    plugins: z.array(marketplaceEntryV1Schema).superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `duplicate plugin id "${entry.id}"`,
          });
        }
        seen.add(entry.id);
      });
    }),
  })
  .strict();

const marketplaceManifestV2Schema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(2),
  name: z.string().regex(NAME_PATTERN),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  categories: z.array(pluginMarketplaceCategorySchema).optional(),
  collections: z.array(pluginMarketplaceCollectionSchema).optional(),
  plugins: z.array(marketplaceEntryV2Schema),
});

export type MarketplaceManifestV1 = z.infer<typeof marketplaceManifestV1Schema>;
export type MarketplaceManifestV2 = z.infer<typeof marketplaceManifestV2Schema>;
export type MarketplaceManifest = MarketplaceManifestV1 | MarketplaceManifestV2;
export type MarketplaceEntryV1 = MarketplaceManifestV1["plugins"][number];
export type MarketplaceEntryV2 = MarketplaceManifestV2["plugins"][number];
export type MarketplaceEntry = MarketplaceEntryV1 | MarketplaceEntryV2;
export type BundledMarketplaceEntry = MarketplaceEntryV2 & {
  source: Extract<MarketplaceEntryV2["source"], { bundled: object }>;
};

export function isBundledMarketplaceEntry(
  entry: MarketplaceEntry,
): entry is BundledMarketplaceEntry {
  return "bundled" in entry.source;
}

export interface MarketplaceCollectionMembership {
  id: string;
  rank: number;
}

interface MarketplaceManifestIndex {
  categories: ReadonlyMap<string, PluginMarketplaceCategory>;
  collections: ReadonlyMap<string, readonly MarketplaceCollectionMembership[]>;
  resolvedCollections: readonly PluginMarketplaceCollection[];
}

const marketplaceManifestIndexes = new WeakMap<
  MarketplaceManifest,
  MarketplaceManifestIndex
>();

function marketplaceManifestIndex(
  manifest: MarketplaceManifest,
): MarketplaceManifestIndex {
  const existing = marketplaceManifestIndexes.get(manifest);
  if (existing !== undefined) return existing;
  const categories = new Map<string, PluginMarketplaceCategory>();
  const collections = new Map<string, MarketplaceCollectionMembership[]>();
  const resolvedCollections: PluginMarketplaceCollection[] = [];
  if (manifest.schemaVersion === 2) {
    for (const category of manifest.categories ?? []) {
      categories.set(category.id, category);
    }
    const entryIds = new Set(manifest.plugins.map((entry) => entry.id));
    for (const collection of manifest.collections ?? []) {
      let rank = 0;
      const pluginIds: string[] = [];
      for (const entryId of collection.pluginIds) {
        if (!entryIds.has(entryId)) continue;
        pluginIds.push(entryId);
        const memberships = collections.get(entryId) ?? [];
        memberships.push({ id: collection.id, rank });
        collections.set(entryId, memberships);
        rank += 1;
      }
      resolvedCollections.push({
        id: collection.id,
        displayName: collection.displayName,
        pluginIds,
      });
    }
  }
  const index = { categories, collections, resolvedCollections };
  marketplaceManifestIndexes.set(manifest, index);
  return index;
}

export function parseMarketplaceManifest(
  input: unknown,
  location: string,
  warn?: (message: string) => void,
): MarketplaceManifest {
  return parseMarketplaceManifestWithBundledPolicy(
    input,
    location,
    false,
    warn,
  );
}

export function parseBundledMarketplaceManifest(
  input: unknown,
  location: string,
): MarketplaceManifestV2 {
  const manifest = parseMarketplaceManifestWithBundledPolicy(
    input,
    location,
    true,
  );
  if (
    manifest.schemaVersion !== 2 ||
    manifest.name !== BUNDLED_MARKETPLACE_NAME
  ) {
    throw new Error(
      `invalid ${location}: the bundled marketplace must be a v2 document named "${BUNDLED_MARKETPLACE_NAME}"`,
    );
  }
  const nonBundled = manifest.plugins.find(
    (entry) => !isBundledMarketplaceEntry(entry),
  );
  if (nonBundled !== undefined) {
    throw new Error(
      `invalid ${location}: entry "${nonBundled.id}" in "${BUNDLED_MARKETPLACE_NAME}" must use a bundled source`,
    );
  }
  return manifest;
}

function parseMarketplaceManifestWithBundledPolicy(
  input: unknown,
  location: string,
  allowBundled: boolean,
  warn?: (message: string) => void,
): MarketplaceManifest {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion !== 1 &&
    input.schemaVersion !== 2
  ) {
    throw new Error(
      `invalid ${location}: unknown schemaVersion ${JSON.stringify(input.schemaVersion)}; supported values are 1 and 2`,
    );
  }
  const schema =
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion === 2
      ? marketplaceManifestV2Schema
      : marketplaceManifestV1Schema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid ${location}: ${formatIssues(parsed.error)}`);
  }
  const bundled = parsed.data.plugins.find(isBundledMarketplaceEntry);
  if (bundled !== undefined && !allowBundled) {
    throw new Error(
      `invalid ${location}: bundled source on entry "${bundled.id}" is reserved for the built-in "${BUNDLED_MARKETPLACE_NAME}" marketplace and is not allowed in fetched or third-party documents`,
    );
  }
  if (parsed.data.schemaVersion === 1) return parsed.data;
  const plugins = parsed.data.plugins.filter((entry) => {
    if ("bundled" in entry.source) return true;
    const range =
      "range" in entry.source.git ? entry.source.git.range : undefined;
    if (range === undefined || semver.validRange(range) !== null) return true;
    warn?.(
      `marketplace entry "${entry.id}" was skipped because source range ${JSON.stringify(range)} is not valid semver`,
    );
    return false;
  });
  return plugins.length === parsed.data.plugins.length
    ? parsed.data
    : { ...parsed.data, plugins };
}

export function marketplaceEntryCategory(
  manifest: MarketplaceManifest,
  entry: MarketplaceEntry,
): PluginMarketplaceCategory | undefined {
  if (manifest.schemaVersion !== 2 || !("category" in entry)) return undefined;
  const categoryId = entry.category;
  if (categoryId === undefined) return undefined;
  const declared =
    marketplaceManifestIndex(manifest).categories.get(categoryId);
  if (declared !== undefined) return declared;
  return pluginCatalogCategory(categoryId);
}

export function marketplaceEntryCollections(
  manifest: MarketplaceManifest,
  entryId: string,
): MarketplaceCollectionMembership[] {
  return [
    ...(marketplaceManifestIndex(manifest).collections.get(entryId) ?? []),
  ];
}

export function marketplaceCategories(
  manifest: MarketplaceManifest,
): PluginMarketplaceCategory[] {
  return [...marketplaceManifestIndex(manifest).categories.values()];
}

export function marketplaceCollections(
  manifest: MarketplaceManifest,
): PluginMarketplaceCollection[] {
  return [...marketplaceManifestIndex(manifest).resolvedCollections];
}

export function parseMarketplaceManifestJson(
  raw: string,
  location: string,
  warn?: (message: string) => void,
): MarketplaceManifest {
  return parseMarketplaceManifest(
    parseJsonDocument(raw, location),
    location,
    warn,
  );
}

export function parseBundledMarketplaceManifestJson(
  raw: string,
  location: string,
): MarketplaceManifestV2 {
  return parseBundledMarketplaceManifest(
    parseJsonDocument(raw, location),
    location,
  );
}

export function parseStoredMarketplaceManifest(
  row: { name: string; manifestJson: string },
  warn?: (message: string) => void,
): MarketplaceManifest {
  const location = `stored "${row.name}" marketplace catalog`;
  return row.name === BUNDLED_MARKETPLACE_NAME
    ? parseBundledMarketplaceManifestJson(row.manifestJson, location)
    : parseMarketplaceManifestJson(row.manifestJson, location, warn);
}

export function entryIconName(entry: MarketplaceEntry): string | null {
  return typeof entry.icon === "string" ? entry.icon : null;
}

export function entryOverview(
  entry: MarketplaceEntry,
  warn?: (message: string) => void,
): string | undefined {
  if (!("overview" in entry) || entry.overview === undefined) return undefined;
  const length = [...entry.overview.replace(/\n$/u, "")].length;
  if (length > MARKETPLACE_OVERVIEW_MAX_CHARS) {
    warn?.(
      `marketplace entry "${entry.id}" overview text was skipped because it has ${length} characters; the maximum is ${MARKETPLACE_OVERVIEW_MAX_CHARS}`,
    );
    return undefined;
  }
  return entry.overview;
}

function legacyMarketplaceCategory(tags: readonly string[]): string {
  const first = tags[0];
  return first === undefined
    ? "Other"
    : first
        .split("-")
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

export function catalogEntryMetadata(args: {
  manifest: MarketplaceManifest;
  entry: MarketplaceEntry;
  base: MarketplaceIconBase;
  warn?: (message: string) => void;
}): {
  categoryId?: string;
  category?: string;
  screenshots: string[];
  publishedAt?: string;
  updatedAt?: string;
} {
  const { manifest, entry } = args;
  const category = marketplaceEntryCategory(manifest, entry);
  return {
    ...(manifest.schemaVersion === 1
      ? { category: legacyMarketplaceCategory(entry.tags ?? []) }
      : category === undefined
        ? {}
        : { categoryId: category.id, category: category.displayName }),
    screenshots: [],
    ...("publishedAt" in entry && typeof entry.publishedAt === "string"
      ? { publishedAt: entry.publishedAt }
      : {}),
    ...("updatedAt" in entry && typeof entry.updatedAt === "string"
      ? { updatedAt: entry.updatedAt }
      : {}),
  };
}

export function entryIconTinted(contentType: string): boolean {
  return contentType === "image/svg+xml";
}

export interface MarketplaceIconBase {
  kind: "dir";
  root: string;
}

export function marketplaceRowIconBase(row: {
  manifestUrl: string;
}): MarketplaceIconBase {
  return { kind: "dir", root: row.manifestUrl };
}

export interface MarketplaceIconLocation {
  path: string;
  relativePath: string;
}

export function resolveEntryIcon(
  entry: MarketplaceEntry,
  base: MarketplaceIconBase,
): MarketplaceIconLocation | null {
  if (typeof entry.icon === "string") return null;
  const declared = entry.icon.url;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(declared)) {
    throw new Error(
      `icon URL ${JSON.stringify(declared)} must be a path inside the marketplace`,
    );
  }
  const resolved = new URL(declared, "https://marketplace.invalid/");
  const relativePath = normalizePluginSubdirectory(
    decodeURIComponent(resolved.pathname).replace(/^\/+/u, ""),
  );
  return {
    path: join(base.root, ...relativePath.split("/")),
    relativePath,
  };
}

export function entryRepositoryUrl(entry: MarketplaceEntry): string | null {
  if ("bundled" in entry.source) return null;
  const git = entry.source.git;
  const repository = git.url.replace(/\.git$/u, "");
  if (git.subdir === undefined) return repository;
  const path = git.subdir.split("/").map(encodeURIComponent).join("/");
  return new URL(repository).host === "github.com"
    ? `${repository}/tree/HEAD/${path}`
    : repository;
}

export function entrySourceDisplay(entry: MarketplaceEntry): string {
  if ("bundled" in entry.source) {
    return `builtin:${entry.source.bundled.plugin}`;
  }
  const git = entry.source.git;
  const subdir = git.subdir === undefined ? "" : `#${git.subdir}`;
  if ("ref" in git) return `git:${git.url}@${git.ref}${subdir}`;
  const prefix = git.tagPrefix ?? "";
  return `git:${git.url}@${git.range}${subdir} (tags ${gitSemverTagName(prefix, "X.Y.Z")})`;
}

interface ResolvedEntrySource {
  source: string;
  selection: PluginSourceSelection;
}

export function resolvedEntrySource(
  entry: MarketplaceEntry,
): ResolvedEntrySource {
  if ("bundled" in entry.source) {
    return {
      source: `builtin:${entry.source.bundled.plugin}`,
      selection: ROOT_PLUGIN_SOURCE_SELECTION,
    };
  }
  const git = entry.source.git;
  return {
    source:
      "ref" in git
        ? `git:${git.url}@${git.ref}`
        : gitRangeSourceSpec({
            url: git.url,
            range: git.range,
            tagPrefix: git.tagPrefix ?? "",
          }),
    selection:
      git.subdir === undefined
        ? ROOT_PLUGIN_SOURCE_SELECTION
        : { kind: "subdirectory", path: git.subdir },
  };
}
