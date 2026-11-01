// The sandy mark, once. Every logo, icon and favicon in the repo is rendered
// from these shapes (apps/app/scripts/generate-pwa-icons.mjs and
// scripts/generate-brand-assets.mjs), so there is one authoritative drawing.
//
// Two forms of one idea, a sun disc over dunes:
//  - the mark: the disc with three dune layers cut into it (colour, default)
//  - the glyph: the disc with the dune lines cut out (one colour, an alpha
//    mask: tints, themed icons, tab favicons that the user recolours)
// Both live in a 512 box; the disc has radius 236 around (256, 256).

export const GROUND = "#11151b";
export const GROUND_DEEP = "#0a0e12";
export const INK = "#e5e8ec";

// Disc, then three dune layers from light to deep (docs/DESIGN.md: sandy).
export const palettes = {
  sandy: ["#eda253", "#d97b2b", "#b85f1d", "#8f4714"],
  // dev builds must not be mistaken for the real app: cool blue (--working)
  dev: ["#6cc0ee", "#3f98d1", "#2e78a8", "#215a80"],
  // nightly: violet (--merged)
  nightly: ["#b293fb", "#8a63e0", "#6c47bd", "#503494"],
};

const DISC = 236;
// Tight box around the disc, for standalone logos.
export const TIGHT_VIEWBOX = "20 20 472 472";

export function markShapes(palette = palettes.sandy) {
  const [disc, d1, d2, d3] = palette;
  return `<clipPath id="disc"><circle cx="256" cy="256" r="${DISC}"/></clipPath><g clip-path="url(#disc)"><circle cx="256" cy="256" r="${DISC}" fill="${disc}"/><path d="M0 300C90 230 170 230 250 285s170 40 262-40v300H0z" fill="${d1}"/><path d="M0 372C100 312 190 312 270 362s160 30 242-20v200H0z" fill="${d2}"/><path d="M0 440c110-50 200-40 290 0s150 20 222-14v120H0z" fill="${d3}"/></g>`;
}

export function glyphShapes(fill = "#fff") {
  return `<mask id="cut"><rect width="512" height="512" fill="#fff"/><g fill="none" stroke="#000" stroke-width="22" stroke-linecap="round"><path d="M-20 290C80 225 170 225 250 280s170 40 280-35"/><path d="M-20 356C80 291 170 291 250 346s170 40 280-35"/><path d="M-20 422C80 357 170 357 250 412s170 40 280-35"/></g></mask><circle cx="256" cy="256" r="${DISC}" fill="${fill}" mask="url(#cut)"/>`;
}

/** The mark alone, cropped to the disc. */
export function markSvg(palette) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${TIGHT_VIEWBOX}">${markShapes(palette)}</svg>`;
}

export function glyphSvg(fill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${TIGHT_VIEWBOX}">${glyphShapes(fill)}</svg>`;
}

/**
 * A square canvas of `size` px. `background` is null (transparent), or
 * { fill, radius } with radius as a fraction of size (0 = full bleed).
 * `inset` shrinks the background tile (fraction of size per side).
 * `disc` is the disc diameter as a fraction of size.
 * `shapes` is markShapes() or glyphShapes().
 */
export function canvasSvg({
  size,
  shapes,
  disc,
  background = null,
  inset = 0,
}) {
  const scale = (disc * size) / (DISC * 2);
  const tile = background
    ? `<rect x="${inset * size}" y="${inset * size}" width="${size * (1 - 2 * inset)}" height="${size * (1 - 2 * inset)}" rx="${background.radius * size}" fill="${background.fill}"/>`
    : "";
  const move = `translate(${size / 2} ${size / 2}) scale(${scale}) translate(-256 -256)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${tile}<g transform="${move}">${shapes}</g></svg>`;
}
