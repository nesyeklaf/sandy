#!/usr/bin/env node
// Renders the sandy logo and the desktop, mobile and README icons from the
// one drawing in apps/app/scripts/brand-marks.mjs. The web app's own icons
// come from apps/app/scripts/generate-pwa-icons.mjs.
//
//   node scripts/generate-brand-assets.mjs          write
//   node scripts/generate-brand-assets.mjs --check  fail when a file is stale
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUND,
  GROUND_DEEP,
  canvasSvg,
  glyphShapes,
  glyphSvg,
  markShapes,
  markSvg,
  palettes,
} from "../apps/app/scripts/brand-marks.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sharp = createRequire(join(root, "apps/app/package.json"))("sharp");
const checkOnly = process.argv.includes("--check");
const stale = [];

const png = (svg, { flatten } = {}) => {
  const image = sharp(Buffer.from(svg), { density: 72 });
  return (flatten ? image.flatten({ background: flatten }) : image)
    .png({ compressionLevel: 9 })
    .toBuffer();
};

async function emit(path, content) {
  const file = join(root, path);
  const existing = await readFile(file).catch(() => null);
  if (existing?.equals(content)) return;
  if (checkOnly) {
    stale.push(path);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

// A macOS-style app tile: 824 of 1024 px, 22.5% corners, a hairline edge.
function macTile(palette, size = 1024) {
  const tile = canvasSvg({
    size,
    shapes: markShapes(palette),
    disc: 0.5,
    background: { fill: GROUND, radius: 0.185 },
    inset: 0.098,
  });
  return tile;
}

const fullBleed = (palette, fill = GROUND) =>
  canvasSvg({
    size: 1024,
    shapes: markShapes(palette),
    disc: 0.62,
    background: { fill, radius: 0 },
  });

const free = (palette, disc, width = 1024, height = 1024) => {
  const side = Math.min(width, height);
  const scale = (disc * side) / 472;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g transform="translate(${width / 2} ${height / 2}) scale(${scale}) translate(-256 -256)">${markShapes(palette)}</g></svg>`;
};

// --- logo, README, Discord ---------------------------------------------
await emit(
  "assets/sandy-logo.svg",
  Buffer.from(`${markSvg(palettes.sandy)}\n`),
);
await emit("assets/sandy-glyph.svg", Buffer.from(`${glyphSvg("#11151b")}\n`));
await emit(
  "assets/sandy-logo.png",
  await png(free(palettes.sandy, 1, 568, 568)),
);
await emit(
  "assets/sandy-logo-dev.png",
  await png(free(palettes.dev, 1, 568, 568)),
);
await emit(
  "assets/sandy-logo-white.png",
  await png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="568" height="568" viewBox="0 0 568 568"><g transform="scale(${568 / 472}) translate(-20 -20)">${glyphShapes("#fff")}</g></svg>`,
  ),
);
await emit(
  "assets/sandy-logo-tile.png",
  await png(fullBleed(palettes.sandy), { flatten: GROUND }),
);

// --- desktop -----------------------------------------------------------
for (const [name, palette] of [
  ["icon", palettes.sandy],
  ["icon-dev", palettes.dev],
  ["icon-nightly", palettes.nightly],
]) {
  await emit(`apps/desktop/assets/${name}.png`, await png(macTile(palette)));
}

// icns is a header plus PNG entries; macOS reads PNG payloads since 10.7.
const icnsTypes = [
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];
async function icns(palette) {
  const entries = [];
  for (const [type, size] of icnsTypes) {
    const data = await png(macTile(palette, size));
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    entries.push(head, data);
  }
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}
await emit("apps/desktop/assets/icon.icns", await icns(palettes.sandy));
await emit(
  "apps/desktop/assets/icon-nightly.icns",
  await icns(palettes.nightly),
);

// --- mobile ------------------------------------------------------------
const mobile = (name, content) => emit(`apps/mobile/assets/${name}`, content);
await mobile(
  "icon.png",
  await png(fullBleed(palettes.sandy), { flatten: GROUND }),
);
await mobile(
  "icon-dev.png",
  await png(fullBleed(palettes.dev), { flatten: GROUND }),
);
await mobile(
  "ios-icon-dark.png",
  await png(fullBleed(palettes.sandy, GROUND_DEEP), { flatten: GROUND_DEEP }),
);
// Adaptive icons: the launcher masks the 108dp canvas to about 66dp.
await mobile(
  "android-icon-foreground.png",
  await png(free(palettes.sandy, 0.52)),
);
await mobile(
  "android-icon-foreground-dev.png",
  await png(free(palettes.dev, 0.52)),
);
await mobile(
  "android-icon-background.png",
  await png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${GROUND}"/></svg>`,
  ),
);
await mobile(
  "android-icon-monochrome.png",
  await png(canvasSvg({ size: 1024, shapes: glyphShapes("#fff"), disc: 0.5 })),
);
await mobile("favicon.png", await png(free(palettes.sandy, 1, 48, 48)));
await mobile("favicon-dev.png", await png(free(palettes.dev, 1, 48, 48)));
// The colour mark reads on the light and the dark splash alike.
await mobile("splash-logo.png", await png(free(palettes.sandy, 0.9, 581, 487)));
await mobile(
  "splash-logo-dark.png",
  await png(free(palettes.sandy, 0.9, 581, 487)),
);
await mobile(
  "splash-logo-dev.png",
  await png(free(palettes.dev, 0.9, 581, 487)),
);

if (stale.length > 0) {
  console.error(
    [
      "Generated brand assets are out of date:",
      ...stale.map((path) => `  ${path}`),
      "Run \`node scripts/generate-brand-assets.mjs\`.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
