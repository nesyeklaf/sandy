---
name: Sandy
description: The visual system of Sandy, graphite in cool slate with colour that says who did something and what state a thing is in.
colors:
  sunk: "#0a0e12"
  ground: "#11151b"
  field: "#151a20"
  pop: "#191f26"
  raised: "#ffffff09"
  raised-2: "#ffffff0f"
  raised-3: "#ffffff17"
  rule: "#ffffff13"
  rule-strong: "#ffffff1f"
  scrim: "#00000099"
  ink: "#e5e8ec"
  ink-2: "#c1c4c9"
  ink-soft: "#aaaeb4"
  ink-faint: "#8d939a"
  sandy: "#eda253"
  you: "#83c6bd"
  working: "#53b6eb"
  success: "#4bc680"
  error: "#fd736d"
  merged: "#a27dfa"
typography:
  prose: { fontFamily: "Inter Variable, system-ui, sans-serif", fontSize: "15px", lineHeight: 1.65 }
  title: { fontFamily: "Inter Variable, system-ui, sans-serif", fontSize: "14px", fontWeight: 600 }
  meta: { fontFamily: "Inter Variable, system-ui, sans-serif", fontSize: "12px" }
  caption: { fontFamily: "Inter Variable, system-ui, sans-serif", fontSize: "11px" }
  mono: { fontFamily: "JetBrains Mono Variable, ui-monospace, monospace", fontSize: "13px" }
rounded: { sm: "6px", base: "8px", lg: "12px", xl: "16px", pill: "999px" }
spacing: { unit: "4px", touch: "44px", column: "760px" }
---

# Design

How Sandy looks. Tokens are in the frontmatter above; the prose says how to apply them. What Sandy is for is in the README; this file only holds the look. It follows the DESIGN.md format the impeccable skill reads. Where a screen and this file differ, change one of them in the same commit.

## Overview

Sandy is a place where many sessions run at once, so the screen has to answer one question fast: **what needs me?** Everything else stays quiet. The base is graphite, a dark that is not dead: a cool slate (hue 255, chroma 0.01 to 0.02) so the ground has a temperature, plus colour that carries meaning. Colour is never decoration. It says who acted (amber is Sandy, sea glass is you) or what state a thing is in (sky works, emerald is done, red failed, violet merged).

## Colour

### Slate ramp (levels)

Hue 255 at every level, so surfaces read as one material. Lightness rises with elevation; chroma rises a little with it so lighter steps do not wash out to grey.

| Token | OKLCH | Hex | Use |
| --- | --- | --- | --- |
| `--sunk` | 0.16 0.012 255 | `#0a0e12` | sidebar, inputs, code and output wells |
| `--ground` | 0.195 0.014 255 | `#11151b` | page background |
| `--field` | 0.215 0.015 255 | `#151a20` | the composer's field: the one thing to type in |
| `--pop` | 0.235 0.016 255 | `#191f26` | what floats (menus, sheets); opaque, since the layers are not |
| `--raised` / `-2` / `-3` | white at 3.5% / 6% / 9% | `#ffffff09` / `0f` / `17` | card and hover / current row and chip / pressed and selected |
| `--rule` / `--rule-strong` | white at 7.5% / 12% | `#ffffff13` / `1f` | hairlines, borders |
| `--scrim` | black at 60% | `#00000099` | what dims the screen behind a sheet |

A level is white at low opacity over the ground, not a separate grey, so a card, a hover and a pressed row stay in step on any ground.

### Ink

| Token | OKLCH | Hex | Use |
| --- | --- | --- | --- |
| `--ink` | 0.93 0.006 255 | `#e5e8ec` | text |
| `--ink-2` | 0.82 0.008 255 | `#c1c4c9` | prose |
| `--ink-soft` | 0.75 0.010 255 | `#aaaeb4` | secondary; also text on a pressed or selected row |
| `--ink-faint` | 0.66 0.012 255 | `#8d939a` | metadata; at least 4.5:1 on ground, sunk, field and pop, also under `--raised-2` (4.5:1 on `--pop`, the lowest). A pressed or selected row (`--raised-3`) is below it, so its text uses `--ink-soft`. Check again when a level moves. |

### Meaning

Two jobs, kept apart. **Actor** colours say who. **State** colours say how it is going.

| Token | OKLCH | Hex | Says |
| --- | --- | --- | --- |
| `--sandy` | 0.77 0.13 65 | `#eda253` | Sandy acted; focus ring; **needs you** (a thing waits for an answer) |
| `--you` | 0.78 0.07 185 | `#83c6bd` | you acted or ran it |
| `--working` | 0.74 0.12 235 | `#53b6eb` | a session is working |
| `--success` | 0.74 0.15 155 | `#4bc680` | done, connected, checks pass |
| `--error` | 0.72 0.17 25 | `#fd736d` | failed, error |
| `--merged` | 0.68 0.18 295 | `#a27dfa` | the pull request is merged |

Rules:

- A state is never colour alone. Pair it with a word or an icon (colour-blind users, greyscale screenshots).
- Amber means "your turn". Do not use it for anything that does not wait for you.
- At most one state colour per row. A row that is working, waiting and failed shows the one the owner has to act on first: needs you, then error, then working.
- Tinted fills are the colour at 12 to 16% over the level; the text on them is the colour itself, not a lighter one.
- Light theme: same hues, same names, lightness mirrored (state colours at 0.53 to 0.6). Light is secondary; design and review dark first.

### Project monograms

A project shows as a letter on a rounded square. Eight hues at equal lightness (0.74, chroma 0.09) at hue 20, 65, 110, 155, 200, 245, 290, 335, picked by a stable hash of the project's name, so a project keeps its colour on every device. The monogram never carries state; the status dot does.

## Typography

Inter (variable, latin) for UI and prose; JetBrains Mono (variable, latin) only for commands, output, code, paths, branch names and tabular numbers, ligatures off. Both ship as woff2 so Android does not fall back to Roboto and Droid Sans Mono.

| Role | Size | Notes |
| --- | --- | --- |
| prose | 15px / 1.65 | 16px / 1.6 on the phone |
| title | 14px, 600 | session name, brand; 15px on the phone |
| meta | 12px | sidebar rows 13px |
| caption | 11px | actor, kind |
| mono | 13px | output 12.5px / 1.6 |

Weights: 400 text, 500 small labels, 600 titles and names.

## Shape and space

Radii: 6px chips and badges, 8px controls and rows, 12px cards, popups and menus, 16px composer and sheets (top corners), pills for branch chips. Spacing is a 4px scale (4, 8, 12, 16, 20, 24). Touch targets are at least 44px. The reading column is 760px.

## Depth

Depth comes from white layers and hairlines, not from heavy shadow. `--sunk` for the sidebar, inputs and wells, `--raised` for cards, `--raised-2` for the current row, `--raised-3` for pressed and selected. What floats is `--pop` with a `--rule-strong` hairline and a soft shadow.

## Motion

220ms, ease-out, for things that arrive (a new item rises 4px and settles; a row moves between shelves). Sheets rise from the bottom. A working session shows one breathing dot in `--working`; nothing else loops. Motion explains where something went; it is never there to look busy. Everything respects `prefers-reduced-motion` (the move becomes a fade, the breathing stops).

## Layout

- Desktop: left sidebar (272px) with the sessions grouped in shelves by what needs the owner, the timeline in one readable column, a right panel (diff, file, surface) and a bottom drawer (shell), both closed by default.
- Phone: the timeline fills the screen; the sidebar is a drawer; panel and terminal are full-screen sheets; the composer stays where the thumb is. Everything that works on the desktop works on the phone.
- Shelves (sidebar): Needs you, Working, In review (derived from the open pull request), Waiting, Backlog and the rest. A shelf header carries its name and a count; a session row carries monogram, name, one state dot with its word, and the age. The shelf is the status model; there is no second one.

## Components

- **Your message**: right-aligned bubble on `--raised-2`, at most 80% of the column (88% on the phone), no name.
- **Sandy's reply**: prose in `--ink-2` without a box, under her mark (an amber 20px square with a chevron) and name.
- **Card** (command, surface): 12px radius, hairline, `--raised`; a card that waits for an answer has a `--sandy` border.
- **Chip / capsule**: 6px or pill, `--raised`, mono when it holds a path or branch.
- **Composer**: one `--field` box, 16px radius, 52px high at least; focus turns the border `--sandy` at 70% with a soft ring.
- **Status dot**: 8px circle in the state colour next to its word; the word is `--ink-soft`, 12px.

## Do and do not

- Do use colour to say who acted or what state a thing is in; do not use it as decoration.
- Do keep the ground cool and slightly coloured; do not use pure grey (chroma 0) or pure black for a level.
- Do mark a state with colour and a word or icon.
- Do not draw structure with a coloured edge on one side of a card or row; use a shape or a hairline.
- Do not put a gradient on text, glassmorphism on a surface, or the same card repeated as a grid of icon, heading and sentence.
- Do not ship a new component without its dark state checked against the contrast rule for `--ink-faint`.
- Use mono only where the content is code-like. Lucide icons only, imported one at a time.

## Origin

The levels, ink scale, type, radii and the amber and sea-glass pair come from the earlier Sandy prototype's Graphite direction (chosen 2026-10-18). The state colours and the graphite-with-hue ground are new in the fork (2026-10-31): the earlier ramp had chroma 0, which the owner found dull.
