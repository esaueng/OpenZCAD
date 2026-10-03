#!/usr/bin/env bash
# Rebuilds the "OpenZCAD Symbols" fallback faces in apps/web/src/theme/fonts/.
#
# Geist, the interface face, has no ⌀, ∠, ∥, ⊥, ⌘ and the like, and a browser
# that restricts local fonts finds no system font that draws them either, so
# it paints the hex missing-glyph box. These two subsets carry just the glyphs
# the interface writes and Geist lacks; scripts/check-glyph-coverage.mjs fails
# when the interface writes one that neither Geist nor these faces draw.
#
# To add a glyph: append it to MATH_GLYPHS (or SYMBOL_GLYPHS when only Noto
# Sans Symbols 2 has it), mirror the code point in the matching unicode-range
# in apps/web/src/theme/tokens.css, and rerun this script.
#
# Needs npm and Python 3 with fonttools and brotli (pip install fonttools
# brotli). Sources are the pinned Fontsource packages, both SIL OFL 1.1 with
# no Reserved Font Name; the license text is LICENSE-Noto.txt beside the faces.
set -euo pipefail

MATH_PACKAGE='@fontsource/noto-sans-math@5.3.0'
MATH_FILE='noto-sans-math-latin-400-normal.woff2'
# ⌀ ∠ Δ ∥ ⊥ ⊕ □ ◇ ◎ ▾
MATH_GLYPHS='U+2300,U+2220,U+0394,U+2225,U+22A5,U+2295,U+25A1,U+25C7,U+25CE,U+25BE'

SYMBOL_PACKAGE='@fontsource/noto-sans-symbols-2@5.3.0'
SYMBOL_FILE='noto-sans-symbols-2-symbols-400-normal.woff2'
# ⌘ ⌥ ⌫ ⚠
SYMBOL_GLYPHS='U+2318,U+2325,U+232B,U+26A0'

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/apps/web/src/theme/fonts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

extract() {
  local package="$1" file="$2" dest="$3"
  (cd "$work" && npm pack --silent "$package" >/dev/null)
  tar -xzf "$work"/fontsource-*.tgz -C "$work" "package/files/$file"
  mv "$work/package/files/$file" "$dest"
  rm -rf "$work"/fontsource-*.tgz "$work/package"
}

subset() {
  local source="$1" glyphs="$2" dest="$3"
  python3 -m fontTools.subset "$source" \
    --unicodes="$glyphs" \
    --flavor=woff2 \
    --layout-features='' \
    --no-hinting \
    --desubroutinize \
    --name-IDs='*' \
    --output-file="$dest"
}

extract "$MATH_PACKAGE" "$MATH_FILE" "$work/math.woff2"
extract "$SYMBOL_PACKAGE" "$SYMBOL_FILE" "$work/symbols.woff2"
subset "$work/math.woff2" "$MATH_GLYPHS" "$out/openzcad-symbols-math.woff2"
subset "$work/symbols.woff2" "$SYMBOL_GLYPHS" "$out/openzcad-symbols-keys.woff2"
ls -l "$out"/openzcad-symbols-*.woff2
