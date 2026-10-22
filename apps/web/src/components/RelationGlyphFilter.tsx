import {
  SKETCH_RELATION_GLYPH_KINDS,
  type SketchRelationGlyphKind
} from '@openzcad/shared';
import { SKETCH_RELATION_GLYPHS } from '../lib/sketch/relationGlyphs';

/**
 * The per-kind show/hide filter for viewport relation glyphs: one toggle per
 * kind, drawn with the glyph it controls. Pressed is shown. Presentation
 * only; the relations themselves are untouched.
 */
export function RelationGlyphFilter({
  hidden,
  disabled = false,
  onChange
}: {
  hidden: readonly SketchRelationGlyphKind[];
  disabled?: boolean;
  onChange(hidden: SketchRelationGlyphKind[]): void;
}) {
  const hiddenSet = new Set(hidden);
  return (
    <div
      className="relation-glyph-filter"
      role="group"
      aria-label="Relation glyph kinds"
    >
      {SKETCH_RELATION_GLYPH_KINDS.map((kind) => {
        const { symbol, label } = SKETCH_RELATION_GLYPHS[kind];
        const shown = !hiddenSet.has(kind);
        return (
          <button
            key={kind}
            type="button"
            className="relation-glyph-toggle"
            data-kind={kind}
            aria-pressed={shown}
            aria-label={`Show ${label} glyphs`}
            title={`${label} glyphs ${shown ? 'shown' : 'hidden'}`}
            disabled={disabled}
            onClick={() =>
              onChange(
                SKETCH_RELATION_GLYPH_KINDS.filter((candidate) =>
                  candidate === kind ? shown : hiddenSet.has(candidate)
                )
              )
            }
          >
            <span aria-hidden="true">{symbol}</span>
          </button>
        );
      })}
    </div>
  );
}
