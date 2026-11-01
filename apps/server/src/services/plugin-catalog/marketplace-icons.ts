import { open } from "node:fs/promises";
import {
  listPluginMarketplaceIcons,
  type DbConnection,
  type PluginMarketplaceIconRow,
  type UpsertPluginMarketplaceIconInput,
} from "@sandy/db";
import { assertValidPluginCompactIconSvg } from "@sandy/plugin-build";
import { marketplaceErrorMessage } from "./marketplace-http.js";
import { brandingAssetHash } from "../plugins/app-bundle.js";
import { realPathInside } from "../plugins/install-sources.js";
import {
  resolveEntryIcon,
  type MarketplaceEntry,
  type MarketplaceIconBase,
  type MarketplaceIconLocation,
} from "./marketplace-manifest.js";

const MARKETPLACE_ICON_MAX_BYTES = 256 * 1024;

export async function readBoundedMarketplaceIconFile(
  path: string,
): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("icon is not a regular file");
    const buffer = Buffer.allocUnsafe(MARKETPLACE_ICON_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MARKETPLACE_ICON_MAX_BYTES) {
      throw new Error(`icon exceeds ${MARKETPLACE_ICON_MAX_BYTES} bytes`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

const MARKETPLACE_ICON_CONCURRENCY = 6;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(bytes: Uint8Array, magic: number[]): boolean {
  return (
    bytes.length >= magic.length &&
    magic.every((byte, index) => bytes[index] === byte)
  );
}

function isWebp(bytes: Uint8Array): boolean {
  const ascii = (offset: number, text: string): boolean =>
    bytes.length >= offset + text.length &&
    text
      .split("")
      .every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  return ascii(0, "RIFF") && ascii(8, "WEBP");
}

export function marketplaceIconContentTypeForPath(
  filePath: string,
  bytes: Uint8Array,
): string {
  const pathname = filePath.toLowerCase();
  if (bytes.byteLength > MARKETPLACE_ICON_MAX_BYTES) {
    throw new Error(`icon exceeds ${MARKETPLACE_ICON_MAX_BYTES} bytes`);
  }
  if (pathname.endsWith(".svg")) {
    assertValidPluginCompactIconSvg(bytes, "icon");
    return "image/svg+xml";
  }
  if (pathname.endsWith(".png")) {
    if (!startsWithBytes(bytes, PNG_MAGIC)) {
      throw new Error("icon is not a PNG file");
    }
    return "image/png";
  }
  if (pathname.endsWith(".webp")) {
    if (!isWebp(bytes)) throw new Error("icon is not a WebP file");
    return "image/webp";
  }
  throw new Error("icon must be a .svg, .png, or .webp file");
}

export async function readMarketplaceIcons(args: {
  db: DbConnection;
  marketplaceName: string;
  base: MarketplaceIconBase;
  entries: readonly MarketplaceEntry[];
  warn?: (message: string) => void;
}): Promise<UpsertPluginMarketplaceIconInput[]> {
  const wanted = new Map<string, MarketplaceIconLocation>();
  for (const entry of args.entries) {
    let icon: MarketplaceIconLocation | null;
    try {
      icon = resolveEntryIcon(entry, args.base);
    } catch (error) {
      args.warn?.(
        `marketplace ${args.marketplaceName} entry "${entry.id}": ${marketplaceErrorMessage(error)}`,
      );
      continue;
    }
    if (icon !== null) wanted.set(entry.id, icon);
  }

  const cachedByEntryId = new Map(
    listPluginMarketplaceIcons(args.db, args.marketplaceName).map((icon) => [
      icon.entryId,
      icon,
    ]),
  );
  const resolved = new Map<string, UpsertPluginMarketplaceIconInput>();
  const pending = [...wanted.entries()];

  const runOne = async (
    entryId: string,
    icon: MarketplaceIconLocation,
  ): Promise<void> => {
    const sourceUrl = iconSourceUrl(icon);
    const cached = cachedByEntryId.get(entryId);
    const unchangedUrl = cached?.sourceUrl === sourceUrl;
    try {
      resolved.set(
        entryId,
        await readOneLocalIcon({
          marketplaceName: args.marketplaceName,
          entryId,
          icon,
          base: args.base,
        }),
      );
    } catch (error) {
      args.warn?.(
        `marketplace ${args.marketplaceName} entry "${entryId}" icon ${sourceUrl} was rejected: ${marketplaceErrorMessage(error)}`,
      );
      if (cached !== undefined && unchangedUrl) {
        resolved.set(entryId, iconInputFromRow(cached));
      }
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = pending.shift();
      if (next === undefined) return;
      await runOne(next[0], next[1]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MARKETPLACE_ICON_CONCURRENCY, pending.length) },
      worker,
    ),
  );

  return [...wanted.keys()]
    .map((entryId) => resolved.get(entryId))
    .filter(
      (icon): icon is UpsertPluginMarketplaceIconInput => icon !== undefined,
    );
}

function iconSourceUrl(icon: MarketplaceIconLocation): string {
  return `file:${icon.relativePath}`;
}

async function readOneLocalIcon(args: {
  marketplaceName: string;
  entryId: string;
  icon: MarketplaceIconLocation;
  base: MarketplaceIconBase;
}): Promise<UpsertPluginMarketplaceIconInput> {
  const path = await realPathInside(
    args.base.root,
    args.icon.path,
    `entry "${args.entryId}" icon`,
  );
  const bytes = await readBoundedMarketplaceIconFile(path);
  return {
    marketplaceName: args.marketplaceName,
    entryId: args.entryId,
    sourceUrl: iconSourceUrl(args.icon),
    contentType: marketplaceIconContentTypeForPath(
      args.icon.relativePath,
      bytes,
    ),
    etag: null,
    contentHash: brandingAssetHash(bytes),
    bytes: Buffer.from(bytes),
  };
}

function iconInputFromRow(
  row: PluginMarketplaceIconRow,
): UpsertPluginMarketplaceIconInput {
  const { updatedAt: _updatedAt, ...input } = row;
  return input;
}
