# Prism Fold identity

The OpenZCAD mark is a folded Z with flat blue planes. Its depth comes from
the silhouette and the contrast between faces; it does not need gradients,
outlines, shadows, or a surrounding frame.

## Assets

The web app serves the following files from `apps/web/public/`:

| File                               | Use                                               |
| ---------------------------------- | ------------------------------------------------- |
| `brand/mark.svg`                   | Standalone color mark on light or dark surfaces   |
| `brand/mark-monochrome.svg`        | Single-color reproduction; defaults to black      |
| `brand/logo.svg`                   | Horizontal logo for light backgrounds             |
| `brand/logo-light.svg`             | Horizontal logo for dark backgrounds              |
| `brand/app-icon.svg`               | Editable vector master for the dark app-icon tile |
| `favicon.svg`                      | Compact browser-tab mark                          |
| `favicon-16.png`, `favicon-32.png` | Raster favicon fallbacks                          |
| `apple-touch-icon.png`             | 180px home-screen icon                            |

The desktop shell uses `apps/desktop/src-tauri/icons/icon.png` and `icon.icns`,
rendered from the same app-icon master. Keep the surrounding tile and padding
when using an app icon. Use the standalone mark for toolbar and brand lockups.

The logo wordmark is outlined from the project's existing Geist Sans Medium
font, so exported SVGs do not depend on a font being installed. In the app,
the existing live, accessible OpenZCAD text uses that same font family and weight.
The mark is decorative alongside the text and does not add a second accessible name.

## Source and regeneration

`apps/web/src/assets/prism-fold.json` owns the silhouette, face paths and colors.
`BrandMark.tsx` reads it directly. The continuous silhouette underneath the faces
prevents transparent antialiasing seams between adjacent planes. The compact
version trims the outer padding; it retains the same silhouette and colors.
The monochrome version uses the solid silhouette without fine face outlines.

After a frozen dependency install, run from the repository root:

```sh
pnpm brand:generate
pnpm brand:check
```

Generation uses the existing pinned OpenType parser, Geist font and Tauri icon
renderer. No additional dependency or platform icon utility is required. The
generator writes the SVG masters, favicon PNGs, touch icon and desktop PNG/ICNS;
temporary outputs for other platforms are removed. `brand:check` checks exported
SVGs against the canonical source and the outlined wordmark. It does not render
or compare the PNG/ICNS files.

For small-size review, inspect the favicon at 16px and 32px and the in-app mark
at 18px, 20px and 34px against both light and dark backgrounds. Enlarged previews
are useful for spotting seams, but do not replace viewing the actual sizes.

## Color

| Plane                | Color     |
| -------------------- | --------- |
| Front                | `#3b82f6` |
| Upper faces          | `#93c5fd` |
| Side and lower faces | `#2456c7` |
| App-icon tile        | `#111827` |

Keep the brand colors independent of the interface's theme accent. Use the
monochrome variant when color reproduction is unavailable; its SVG inherits
`currentColor` when embedded inline. Do not recolor individual planes or stretch
the mark. Allow at least one top-bar thickness of clear space around standalone
brand presentations; small interface placements use the compact optical size.
