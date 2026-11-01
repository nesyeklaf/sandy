import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  GROUND,
  canvasSvg,
  glyphShapes,
  markShapes,
  palettes,
} from "./brand-marks.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(appDir, "public");
const checkOnly = process.argv.includes("--check");

// Colours a user can pick for the favicon (and the installed icon).
const faviconColorValues = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffba18",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
};

// Install icons. `any`: a rounded tile with transparent corners. `maskable`
// and the apple-touch icon: full bleed, because the platform cuts the shape
// (the disc stays inside the 80% maskable safe circle; iOS renders
// transparency as black).
const icons = [
  { file: "icon-192.png", size: 192, tile: "rounded", disc: 0.62 },
  { file: "icon-512.png", size: 512, tile: "rounded", disc: 0.62 },
  { file: "icon-192-maskable.png", size: 192, tile: "bleed", disc: 0.6 },
  { file: "icon-512-maskable.png", size: 512, tile: "bleed", disc: 0.6 },
  { file: "apple-touch-icon.png", size: 180, tile: "bleed", disc: 0.64 },
];

// Monochrome manifest icons are alpha masks: the platform supplies the fill
// when tinting (Android themed icons, notification badges). Themed icons are
// cropped to a circle of about 66%, so the glyph stays inside it.
const monochromeIcons = [
  { file: "icon-monochrome-192.png", size: 192 },
  { file: "icon-monochrome-512.png", size: 512 },
];

const faviconSizes = [16, 32];

const mismatches = [];

function installIconSvg(icon, shapes) {
  return canvasSvg({
    size: icon.size,
    shapes,
    disc: icon.disc,
    background: {
      fill: GROUND,
      radius: icon.tile === "rounded" ? 0.225 : 0,
    },
  });
}

function render(svg, { flatten = false } = {}) {
  const image = sharp(Buffer.from(svg), { density: 72 });
  return (flatten ? image.flatten({ background: GROUND }) : image)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function outputFileName(file, color) {
  return file.replace(/\.png$/u, `-${color}.png`);
}

function generatedManifest(baseManifest, color) {
  return Buffer.from(
    `${JSON.stringify(
      {
        ...baseManifest,
        icons: baseManifest.icons.map((icon) =>
          icon.purpose === "monochrome"
            ? icon
            : {
                ...icon,
                src: icon.src.replace(/\.png$/u, `-${color}.png`),
              },
        ),
      },
      null,
      2,
    )}\n`,
  );
}

async function writeOrCheck(fileName, content) {
  const filePath = join(publicDir, fileName);
  const existing = await readFile(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.equals(content)) return;
  if (checkOnly) {
    mismatches.push(fileName);
    return;
  }

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const baseManifest = JSON.parse(
  await readFile(join(publicDir, "manifest.webmanifest"), "utf8"),
);

// Default install icons: the colour mark.
for (const icon of icons) {
  await writeOrCheck(
    icon.file,
    await render(installIconSvg(icon, markShapes(palettes.sandy)), {
      flatten: icon.tile === "bleed",
    }),
  );
}

for (const monochromeIcon of monochromeIcons) {
  await writeOrCheck(
    monochromeIcon.file,
    await render(
      canvasSvg({
        size: monochromeIcon.size,
        shapes: glyphShapes("#fff"),
        disc: 0.58,
      }),
    ),
  );
}

// Tab favicons: the mark alone, no tile, filling the tab's pixel box. Dev
// builds are blue. `-mono` is the one-colour glyph that the app recolours
// when the user picks a favicon colour.
for (const size of faviconSizes) {
  const base = { size, disc: 1 };
  await writeOrCheck(
    `favicon-${size}x${size}.png`,
    await render(canvasSvg({ ...base, shapes: markShapes(palettes.sandy) })),
  );
  await writeOrCheck(
    `favicon-${size}x${size}-dev.png`,
    await render(canvasSvg({ ...base, shapes: markShapes(palettes.dev) })),
  );
  await writeOrCheck(
    `favicon-${size}x${size}-mono.png`,
    await render(canvasSvg({ ...base, shapes: glyphShapes("#fff") })),
  );
}

// A chosen colour fills the glyph on the same tile, so a project's tab and
// its installed icon read as one colour.
for (const [color, hex] of Object.entries(faviconColorValues)) {
  for (const icon of icons) {
    await writeOrCheck(
      outputFileName(icon.file, color),
      await render(installIconSvg(icon, glyphShapes(hex)), {
        flatten: icon.tile === "bleed",
      }),
    );
  }

  await writeOrCheck(
    `manifest-${color}.webmanifest`,
    generatedManifest(baseManifest, color),
  );
}

if (mismatches.length > 0) {
  console.error(
    [
      "Generated PWA icon assets are out of date:",
      ...mismatches.map((fileName) => `  ${fileName}`),
      "Run \`pnpm --filter @sandy/app generate:pwa-icons\`.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
