/**
 * The text tool's card: what to write, composed before anything is placed.
 *
 * `T` opens it at once, string field focused. While it is open the outline of
 * whatever has been typed follows the pointer over the sketch plane, and a
 * click on the plane places the object there — the document never holds a
 * placeholder string. Once placed, the object is selected and the entity
 * editor owns its exact values, so this card only ever creates.
 *
 * Enter is not a commit here: placement is the click (or Place, which drops
 * the object where its outline is showing). Escape closes the card and
 * leaves nothing behind.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlignCenter, AlignLeft, AlignRight, X } from 'lucide-react';
import { coerceParamValue } from '@openzcad/document-core';
import type { SketchObjectData, TextAlign } from '@openzcad/shared';
import type { SketchTextDraft } from '../lib/interaction/machine';
import type { SketchPoint } from '../lib/sketch/session';
import {
  textDraftBudgetError,
  textObjectFromPoint
} from '../lib/sketch/textPlacement';
import { paramValueText, previewExpression } from '../lib/model';
import { loadTextFont } from '../lib/textFonts';
import { ExprInput } from './ExprInput';
import { TextObjectFields } from './TextObjectFields';

interface SketchTextCardProps {
  draft: SketchTextDraft;
  scope: Record<string, number>;
  /** The sketch's committed objects; the draft is budgeted with its text. */
  sketchObjects: readonly { data: SketchObjectData }[];
  /** The document-wide text budget's refusal, if it already refuses. */
  documentBudgetError?: string | null;
  /**
   * Where the live outline sits on the plane, written by the viewport as the
   * pointer moves; the sketch origin until the pointer has been there.
   */
  anchorRef?: { readonly current: SketchPoint | null };
  disabled?: boolean;
  onChange(patch: Partial<SketchTextDraft>): void;
  /** Place: the object its outline is showing, where it is showing it. */
  onPlace(object: SketchObjectData): void;
  onCancel(): void;
  /**
   * The chosen face finished loading. The outline is drawn from parsed faces
   * only and never waits for one, so the host redraws it when the face lands
   * rather than on the next keystroke.
   */
  onFaceLoaded?(): void;
}

const ALIGNMENTS: {
  value: TextAlign;
  label: string;
  icon: typeof AlignLeft;
}[] = [
  { value: 'left', label: 'Align left', icon: AlignLeft },
  { value: 'center', label: 'Align center', icon: AlignCenter },
  { value: 'right', label: 'Align right', icon: AlignRight }
];

/** True when a size expression resolves to a positive finite em size. */
function sizeIsValid(text: string, scope: Record<string, number>): boolean {
  const { ok, value } = previewExpression(text, scope);
  return ok && value !== undefined && Number.isFinite(value) && value > 0;
}

export function SketchTextCard({
  draft,
  scope,
  sketchObjects,
  documentBudgetError = null,
  anchorRef,
  disabled = false,
  onChange,
  onPlace,
  onCancel,
  onFaceLoaded
}: SketchTextCardProps) {
  const onFaceLoadedRef = useRef(onFaceLoaded);
  onFaceLoadedRef.current = onFaceLoaded;
  useEffect(() => {
    let live = true;
    void loadTextFont(draft.fontFamily, draft.fontStyle).then(() => {
      if (live) {
        onFaceLoadedRef.current?.();
      }
    });
    return () => {
      live = false;
    };
  }, [draft.fontFamily, draft.fontStyle]);
  // The size field keeps what is typed; the draft only takes a size that
  // resolves, so a half-typed expression never blanks the live outline.
  const [sizeText, setSizeText] = useState(() => paramValueText(draft.size));
  const sizeValid = sizeIsValid(sizeText, scope);
  const empty = draft.text.length === 0;
  const error = empty
    ? null
    : textDraftBudgetError(sketchObjects, draft.text, documentBudgetError);
  const canPlace = !empty && sizeValid && !error && !disabled;

  function submit(event: FormEvent) {
    // Enter in a field is not placement; the click on the plane is.
    event.preventDefault();
  }

  return (
    <div className="sketch-entity-dock">
      <form
        className="sketch-entity-editor sketch-text-card"
        aria-label="Place text"
        onSubmit={submit}
      >
        <header>
          <div>
            <span className="eyebrow">Sketch text</span>
            <strong>Text</strong>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel text"
            onClick={onCancel}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <fieldset disabled={disabled} className="sketch-entity-values">
          <TextObjectFields
            autoFocusText
            value={{
              text: draft.text,
              fontFamily: draft.fontFamily,
              fontStyle: draft.fontStyle
            }}
            onChange={(next) => onChange(next)}
          />
          <div className="sketch-entity-fields">
            <ExprInput
              label="Size (em)"
              value={sizeText}
              scope={scope}
              onChange={(value) => {
                setSizeText(value);
                if (sizeIsValid(value, scope)) {
                  onChange({ size: coerceParamValue(value) });
                }
              }}
            />
            <div className="field">
              <span>Align</span>
              <div
                className="text-style-toggles"
                role="radiogroup"
                aria-label="Alignment"
              >
                {ALIGNMENTS.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={draft.align === value}
                    aria-label={label}
                    title={label}
                    className={
                      draft.align === value ? 'toggle active' : 'toggle'
                    }
                    onClick={() => onChange({ align: value })}
                  >
                    <Icon size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : !sizeValid ? (
            <p className="form-error" role="alert">
              Size must resolve to a number greater than zero.
            </p>
          ) : (
            <p className="field-hint" aria-live="polite">
              {empty
                ? 'Type the text to place.'
                : 'Click the sketch plane to place it.'}
            </p>
          )}
          <footer>
            <button type="button" className="secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canPlace}
              title={
                empty
                  ? 'Type the text first.'
                  : 'Place the text where its outline is showing.'
              }
              onClick={() =>
                onPlace(
                  textObjectFromPoint(
                    anchorRef?.current ?? { x: 0, y: 0 },
                    draft
                  )
                )
              }
            >
              Place
            </button>
          </footer>
        </fieldset>
      </form>
    </div>
  );
}
