#!/usr/bin/env bash
# Rebuilds the "OpenZCAD Symbols" fallback faces in apps/web/src/theme/fonts/.
#
# Geist, the interface face, has no ⌀, ∠, ∥, ⊥, ⌘ and the like, and a browser
# that restricts local fonts finds no system font that draws them either, so
# it paints the hex missing-glyph box. These subsets carry just the glyphs
# the interface writes and Geist lacks; scripts/check-glyph-coverage.mjs fails
# when the interface writes one that neither Geist nor these faces draw.
#
# To add a glyph: append it to MATH_GLYPHS (or SYMBOL_GLYPHS / TEXT_GLYPHS
# when only Noto Sans Symbols 2 / Noto Sans has it), mirror its unicode-range
# in apps/web/src/theme/tokens.css, and rerun this script.
#
# Needs npm and Python 3 with fonttools and brotli (pip install fonttools
# brotli). Sources are pinned Fontsource packages and Noto Sans's full TTF,
# all SIL OFL 1.1 with no Reserved Font Name; LICENSE-Noto.txt is beside the faces.
set -euo pipefail

MATH_PACKAGE='@fontsource/noto-sans-math@5.3.0'
MATH_FILE='noto-sans-math-latin-400-normal.woff2'
# ⌀ ∠ Δ ∥ ⊥ ⊕ □ ◇ ◎ ▾ ∅ ‐
MATH_GLYPHS='U+2300,U+2220,U+0394,U+2225,U+22A5,U+2295,U+25A1,U+25C7,U+25CE,U+25BE,U+2205,U+2010'

SYMBOL_PACKAGE='@fontsource/noto-sans-symbols-2@5.3.0'
SYMBOL_FILE='noto-sans-symbols-2-symbols-400-normal.woff2'
# ⌘ ⌥ ⌫ ⚠
SYMBOL_GLYPHS='U+2318,U+2325,U+232B,U+26A0'

# ‑ ‒ (the Google Fonts subsets omit these; use Noto's full font).
TEXT_COMMIT='ffebf8c1ee449e544955a7e813c54f9b73848eac'
TEXT_SHA256='b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5'
TEXT_GLYPHS='U+2011-2012'

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/apps/web/src/theme/fonts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

extract() {
  local package="$1" file="$2" dest="$3"
  local expected
  case "$package" in
    "$MATH_PACKAGE") expected='CzodkZ4R2VC73rqbNbVpiI94fXZJLFEMNBTAM3DFadjAKrjLQ2Fr+s2yM2c5uS+frBZ2IM+LyMo6COhAzV7hCA==' ;;
    "$SYMBOL_PACKAGE") expected='hFnEnIXOIgLLJ61SO9icRXKoS+LSWoq7ZqKJQ/NaQR7ptdC6+7yW4ci6EuXgsS1S9JmWpciX6w0AFZkU1DKn1A==' ;;
    *) return 1 ;;
  esac
  (cd "$work" && npm pack --registry=https://registry.npmjs.org --ignore-scripts --silent "$package" >/dev/null)
  local actual
  actual="$(openssl dgst -sha512 -binary "$work"/fontsource-*.tgz | openssl base64 -A)"
  [[ "$actual" == "$expected" ]] || { echo 'Font package integrity mismatch.' >&2; return 1; }
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
curl --fail --location --silent --show-error \
  "https://raw.githubusercontent.com/notofonts/noto-fonts/$TEXT_COMMIT/hinted/ttf/NotoSans/NotoSans-Regular.ttf" \
  --output "$work/text.ttf"
actual="$(openssl dgst -sha256 "$work/text.ttf" | awk '{print $NF}')"
[[ "$actual" == "$TEXT_SHA256" ]] || { echo 'Font source integrity mismatch.' >&2; exit 1; }
subset "$work/math.woff2" "$MATH_GLYPHS" "$out/openzcad-symbols-math.woff2"
subset "$work/symbols.woff2" "$SYMBOL_GLYPHS" "$out/openzcad-symbols-keys.woff2"
subset "$work/text.ttf" "$TEXT_GLYPHS" "$out/openzcad-symbols-text.woff2"
ls -l "$out"/openzcad-symbols-*.woff2
