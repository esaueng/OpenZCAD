/**
 * The non-numeric half of a text sketch object: the string, the family, and
 * the style toggles.
 *
 * Size and position are ordinary `ParamValue` expressions and belong in
 * `ExprInput` alongside every other dimension. These three are not — a string
 * has no expression form, and family and style are enumerations over what is
 * actually bundled. Keeping them in one component means the create form and
 * the edit form stay in step by construction.
 *
 * Bold and italic are toggles over real font files, not synthesised effects.
 * Not every family ships all four faces (Oswald has no italic, Pacifico only a
 * regular), so a request that cannot be honoured falls back down the registry's
 * style chain — and says so, rather than quietly rendering the wrong weight.
 */
import { useEffect } from 'react';
import {
  FONT_FAMILIES,
  findFontFace,
  fontAssetUrl,
  resolveFontStyle
} from '@openzcad/geometry';
import type { TextFontStyle } from '@openzcad/shared';
import { loadTextFont } from '../lib/textFonts';

export interface TextAttributes {
  text: string;
  fontFamily: string;
  fontStyle: TextFontStyle;
}

interface TextObjectFieldsProps {
  value: TextAttributes;
  onChange(next: TextAttributes): void;
}

/** CSS family name used only for the picker's own previews. */
function previewFamily(familyId: string): string {
  return `openzcad-preview-${familyId}`;
}

/**
 * `@font-face` rules so each option in the picker renders in the face it
 * selects. Generated from the same registry the geometry reads, against the
 * same `/fonts/` URLs, so the preview cannot drift from what gets extruded.
 */
function previewFontFaceCss(): string {
  return FONT_FAMILIES.map((family) => {
    const url = fontAssetUrl(family.id, 'regular');
    return url
      ? `@font-face{font-family:"${previewFamily(family.id)}";src:url("${url}") format("truetype");font-display:swap;}`
      : '';
  }).join('');
}

const PREVIEW_STYLE_ID = 'openzcad-text-preview-fonts';

/** Injects the preview `@font-face` block once per document. */
function usePreviewFontFaces(): void {
  useEffect(() => {
    if (document.getElementById(PREVIEW_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = PREVIEW_STYLE_ID;
    style.textContent = previewFontFaceCss();
    document.head.append(style);
  }, []);
}

/** `regular | bold | italic | boldItalic` from two independent toggles. */
export function styleFromToggles(bold: boolean, italic: boolean): TextFontStyle {
  if (bold && italic) {
    return 'boldItalic';
  }
  return bold ? 'bold' : italic ? 'italic' : 'regular';
}

const BOLD_STYLES: TextFontStyle[] = ['bold', 'boldItalic'];
const ITALIC_STYLES: TextFontStyle[] = ['italic', 'boldItalic'];

export function TextObjectFields({ value, onChange }: TextObjectFieldsProps) {
  usePreviewFontFaces();
  const bold = BOLD_STYLES.includes(value.fontStyle);
  const italic = ITALIC_STYLES.includes(value.fontStyle);

  // The picker previews a family in its own face, so the bytes have to be
  // there. Loading the selected family also warms the cache the geometry
  // provider peeks at, so the outline appears without waiting for a rebuild.
  useEffect(() => {
    void loadTextFont(value.fontFamily, value.fontStyle);
  }, [value.fontFamily, value.fontStyle]);

  const resolved = resolveFontStyle(value.fontFamily, value.fontStyle);
  const substituted = resolved !== undefined && resolved !== value.fontStyle;
  const familyLabel =
    FONT_FAMILIES.find((entry) => entry.id === value.fontFamily)?.family ??
    value.fontFamily;

  function setStyle(nextBold: boolean, nextItalic: boolean): void {
    onChange({ ...value, fontStyle: styleFromToggles(nextBold, nextItalic) });
  }

  return (
    <div className="text-object-fields">
      <label className="field">
        <span>Text</span>
        <input
          type="text"
          value={value.text}
          spellCheck={false}
          onChange={(event) =>
            onChange({ ...value, text: event.target.value })
          }
        />
      </label>
      <label className="field">
        <span>Font</span>
        <select
          value={value.fontFamily}
          style={{ fontFamily: `"${previewFamily(value.fontFamily)}", inherit` }}
          onChange={(event) =>
            onChange({ ...value, fontFamily: event.target.value })
          }
        >
          {FONT_FAMILIES.map((family) => (
            <option
              key={family.id}
              value={family.id}
              style={{ fontFamily: `"${previewFamily(family.id)}", inherit` }}
            >
              {family.family}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Style</span>
        <div className="text-style-toggles" role="group" aria-label="Font style">
          <button
            type="button"
            className={bold ? 'toggle active' : 'toggle'}
            aria-pressed={bold}
            onClick={() => setStyle(!bold, italic)}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className={italic ? 'toggle active' : 'toggle'}
            aria-pressed={italic}
            onClick={() => setStyle(bold, !italic)}
          >
            <em>I</em>
          </button>
        </div>
      </div>
      {substituted && (
        <p className="field-hint">
          {familyLabel} has no {value.fontStyle === 'boldItalic' ? 'bold italic' : value.fontStyle} face — using{' '}
          {resolved}. Styles are real font files; there is no synthetic bold or
          italic.
        </p>
      )}
      {findFontFace(value.fontFamily, value.fontStyle) === undefined &&
        resolved === undefined && (
          <p className="form-error" role="alert">
            {familyLabel} is not a bundled family.
          </p>
        )}
    </div>
  );
}
