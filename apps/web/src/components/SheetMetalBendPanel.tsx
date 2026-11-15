import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ParamValue } from '@openzcad/shared';
import {
  BEND_POSITIONS,
  bendOptionId,
  bendTableTitle,
  type BendField,
  type BendRow
} from '../lib/inPlace/sheetMetal';
import type { CurvePick } from '../lib/inPlace/tools';

/**
 * M16: Bend's table, beside its command bar. One row per picked line: its
 * angle, up or down, where the bend sits on the line, and its own radius,
 * K-factor and relief over the sheet's. Every change is a session option
 * (see `bendRows`), so the preview and Done read the table as shown. The
 * fold slider only moves the view: 0 % is the flat sheet the lines are
 * picked on, 100 % the part as Done stores it.
 */
export interface SheetMetalBendPanelProps {
  rows: readonly BendRow[];
  /** The document's length unit, after a radius. */
  unitLabel: string;
  /** A typed number or expression as a number, or null when it is not one. */
  evaluate(text: string): number | null;
  onOption(optionId: string, value: string): void;
  onRemove(line: CurvePick): void;
  /** View only, 0 to 100. */
  fold: number;
  onFold(percent: number): void;
  /** The clicked fixed point, if any (else the largest region stays put). */
  fixedPoint: readonly [number, number] | undefined;
  onClearFixed(): void;
  locked?: boolean;
}

function text(value: ParamValue | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * A row's number or expression: applied on Enter or leaving the field,
 * refused (and kept for correcting) when it does not evaluate. Empty puts an
 * optional override back to the sheet's own.
 */
function ExprField({
  label,
  value,
  placeholder,
  optional,
  evaluate,
  onCommit,
  locked
}: {
  label: string;
  value: string;
  placeholder?: string;
  optional: boolean;
  evaluate(text: string): number | null;
  onCommit(text: string): void;
  locked: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    setDraft(value);
    setRefused(false);
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === value.trim()) {
      setRefused(false);
      return;
    }
    if (trimmed === '' ? !optional : evaluate(trimmed) === null) {
      setRefused(true);
      return;
    }
    setRefused(false);
    onCommit(trimmed);
  };
  return (
    <input
      className={`sheet-bend-field${refused ? ' is-refused' : ''}`}
      aria-label={label}
      aria-invalid={refused || undefined}
      title={refused ? `${draft} is not a number or a known expression` : label}
      value={draft}
      placeholder={placeholder}
      disabled={locked}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          commit();
        } else if (event.key === 'Escape') {
          event.stopPropagation();
          setDraft(value);
          setRefused(false);
        }
      }}
    />
  );
}

export function SheetMetalBendPanel({
  rows,
  unitLabel,
  evaluate,
  onOption,
  onRemove,
  fold,
  onFold,
  fixedPoint,
  onClearFixed,
  locked = false
}: SheetMetalBendPanelProps) {
  const set = (row: BendRow, field: BendField, value: string) =>
    onOption(bendOptionId(row.line.entityId, field), value);
  return (
    <section className="sheet-bend-panel" aria-label="Bend table">
      <header className="sheet-bend-header">
        <span className="sheet-bend-title">{bendTableTitle(rows)}</span>
        <label className="sheet-bend-fold">
          <span>Fold</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={fold}
            aria-label="Fold preview"
            aria-valuetext={`${fold} % folded`}
            onChange={(event) => onFold(Number(event.target.value))}
          />
          <span className="sheet-bend-fold-value mono">{fold} %</span>
        </label>
      </header>
      <p className="sheet-bend-fixed">
        {fixedPoint ? (
          <>
            Fixed where clicked ({fixedPoint[0]}, {fixedPoint[1]})
            <button
              type="button"
              className="sheet-bend-link"
              disabled={locked}
              onClick={onClearFixed}
            >
              Largest
            </button>
          </>
        ) : (
          'The largest region stays fixed · click another to hold it'
        )}
      </p>
      {rows.length > 0 ? (
        <ol className="sheet-bend-rows">
          {rows.map((row, index) => {
            const name = `Bend ${index + 1}`;
            return (
              <li key={`${row.line.sketchId}|${row.line.entityId}`}>
                <div className="sheet-bend-row">
                  <span className="sheet-bend-index mono">{index + 1}</span>
                  <ExprField
                    label={`${name} angle`}
                    value={text(row.angle)}
                    optional={false}
                    evaluate={evaluate}
                    locked={locked}
                    onCommit={(value) => set(row, 'angle', value)}
                  />
                  <span className="sheet-bend-unit">°</span>
                  <span
                    className="sheet-bend-direction"
                    role="group"
                    aria-label={`${name} direction`}
                  >
                    {(['up', 'down'] as const).map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        className="in-place-option-choice"
                        aria-pressed={row.direction === direction}
                        disabled={locked}
                        onClick={() => set(row, 'direction', direction)}
                      >
                        {direction === 'up' ? 'Up' : 'Down'}
                      </button>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="edge-pick-remove"
                    aria-label={`Remove ${name}`}
                    title="Remove this bend"
                    disabled={locked}
                    onClick={() => onRemove(row.line)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
                <div className="sheet-bend-row sheet-bend-row-more">
                  <select
                    className="sheet-bend-select"
                    aria-label={`${name} position`}
                    value={row.position}
                    disabled={locked}
                    onChange={(event) =>
                      set(row, 'position', event.target.value)
                    }
                  >
                    {BEND_POSITIONS.map((position) => (
                      <option key={position.value} value={position.value}>
                        {position.label}
                      </option>
                    ))}
                  </select>
                  <ExprField
                    label={`${name} inside radius (${unitLabel})`}
                    value={text(row.radius)}
                    placeholder="R"
                    optional
                    evaluate={evaluate}
                    locked={locked}
                    onCommit={(value) => set(row, 'radius', value)}
                  />
                  <ExprField
                    label={`${name} K-factor`}
                    value={text(row.kFactor)}
                    placeholder="K"
                    optional
                    evaluate={evaluate}
                    locked={locked}
                    onCommit={(value) => set(row, 'kFactor', value)}
                  />
                  <select
                    className="sheet-bend-select"
                    aria-label={`${name} relief`}
                    value={row.relief?.shape ?? ''}
                    disabled={locked}
                    onChange={(event) => set(row, 'relief', event.target.value)}
                  >
                    <option value="">Sheet relief</option>
                    <option value="rectangular">Rectangular</option>
                    <option value="obround">Obround</option>
                    <option value="none">No relief</option>
                  </select>
                </div>
                {row.relief && row.relief.shape !== 'none' ? (
                  <div className="sheet-bend-row sheet-bend-row-more">
                    <span className="sheet-bend-unit">Relief</span>
                    <ExprField
                      label={`${name} relief width (${unitLabel})`}
                      value={text(row.relief.width)}
                      placeholder="Width = T"
                      optional
                      evaluate={evaluate}
                      locked={locked}
                      onCommit={(value) => set(row, 'reliefWidth', value)}
                    />
                    <ExprField
                      label={`${name} relief extension (${unitLabel})`}
                      value={text(row.relief.extension)}
                      placeholder="Extension = T"
                      optional
                      evaluate={evaluate}
                      locked={locked}
                      onCommit={(value) => set(row, 'reliefExtension', value)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      <p className="sheet-bend-note">
        Radius, K and relief left blank follow the sheet. K-factor and minimum
        radii are rules of thumb.
      </p>
    </section>
  );
}
