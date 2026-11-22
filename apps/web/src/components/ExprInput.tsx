import { useId, useRef, useState } from 'react';
import type { FieldQuantity } from '@openzcad/document-core';
import { displayLengthName } from '@openzcad/shared';
import { formatNumber, previewExpression } from '../lib/model';
import {
  formatShownLength,
  isPlainLengthNumber,
  shownLengthText,
  storedLengthText,
  useDisplayUnits
} from '../lib/displayUnits';
import { useFieldAutoFocus } from './forms/fieldAutoFocus';
import { useParameterDefinition } from './forms/parameterDefinition';
import { useDefineParameterPrompt } from './forms/defineParameterPrompt';

interface ExprInputProps {
  label: string;
  value: string;
  scope: Record<string, number>;
  onChange(value: string): void;
  placeholder?: string;
  /** Allow an empty / zero-result field without flagging it (e.g. offsets). */
  optional?: boolean;
  /**
   * Ask to focus this field when the form opens so typing replaces the
   * default. Honoured only where the panel host allows it — see
   * `useFieldAutoFocus`.
   */
  autoFocus?: boolean;
  error?: string;
  /**
   * Accessible name when it should say more than the visible label — the
   * Move card shows "dX" and names the field "Move X in mm", as the gizmo
   * that creates a Move does.
   */
  ariaLabel?: string;
  /**
   * The quantity this field holds, in the document's units. A typed field
   * evaluates unit suffixes (`1 in + 25.4 mm`) into document units and
   * refuses another dimension; both are required together so no field can
   * accept a suffix without also checking what it measures. Absent, a unit
   * suffix is refused, as it always was.
   */
  quantity?: FieldQuantity;
}

/**
 * Text input for a parametric scalar. Accepts plain numbers or expressions
 * over the parameter table ("w / 2 + 5") and previews the evaluated result
 * inline so broken references are visible before the model rebuilds.
 */
export function ExprInput({
  label,
  value,
  scope,
  onChange,
  placeholder,
  optional,
  autoFocus,
  error,
  ariaLabel,
  quantity
}: ExprInputProps) {
  const id = useId();
  const mayAutoFocus = useFieldAutoFocus(autoFocus);
  const definition = useParameterDefinition();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // I03: a length field in a document shown in other units shows and takes
  // plain numbers in the display unit. `value` and `onChange` stay in the
  // stored units; what is typed is kept as typed while the field has focus,
  // so a converted value never rewrites the text under the caret.
  const stored = quantity?.documentUnits;
  const shown = useDisplayUnits(stored ?? 'mm');
  const converting =
    quantity?.dimension === 'length' &&
    stored !== undefined &&
    shown !== stored;
  const [typed, setTyped] = useState<string | null>(null);
  // A caller that names the stored unit in its label ("Radius (mm)") gets
  // the display unit in its place, not both.
  const storedSuffix =
    stored === undefined ? '' : ` (${displayLengthName(stored)})`;
  const shownLabel =
    converting && storedSuffix && label.endsWith(storedSuffix)
      ? label.slice(0, -storedSuffix.length)
      : label;
  const text =
    converting && stored !== undefined
      ? (typed ?? shownLengthText(value, stored, shown))
      : value;
  const evaluated = previewExpression(value, scope, quantity);
  const preview =
    converting &&
    stored !== undefined &&
    evaluated.ok &&
    evaluated.value !== undefined
      ? {
          ...evaluated,
          text: `= ${formatShownLength(evaluated.value, stored, shown)}`
        }
      : evaluated;
  // The last value this field evaluated to, offered as the value of a name
  // typed over it: `width` over 80 offers `width = 80`.
  const [lastValue, setLastValue] = useState(
    preview.ok ? preview.value : undefined
  );
  if (preview.ok && preview.value !== lastValue) {
    setLastValue(preview.value);
  }

  // A blank optional field is a valid choice, not a missing value: its
  // preview said "required" under "End radius (blank = constant)".
  const blankOptional = Boolean(optional) && value.trim().length === 0;
  const showError = Boolean(error) || (!preview.ok && !blankOptional);
  const isPlainNumber = converting
    ? isPlainLengthNumber(text)
    : /^\s*-?(?:\d+\.?\d*|\.\d+)\s*$/.test(value);
  const showPreview = showError || (!isPlainNumber && !blankOptional);
  // Only when the name is all that is wrong, and it is not a parameter whose
  // own expression is broken (absent from the scope, present in the table).
  const undefinedName =
    !error &&
    definition &&
    preview.undefinedParameter &&
    !definition.has(preview.undefinedParameter)
      ? preview.undefinedParameter
      : null;
  const DefineParameterPrompt = useDefineParameterPrompt(
    definition !== null,
    undefinedName !== null
  );
  const previewLine = (
    <small
      id={`${id}-preview`}
      className={`expr-preview ${showError ? 'error' : ''}`}
    >
      {error ?? preview.text}
    </small>
  );

  // A <div>, not a <label>: the define prompt under the field holds a
  // control of its own, and a label may only contain the one it labels.
  return (
    <div ref={rootRef} className="field expr-field">
      <label id={`${id}-label`} htmlFor={id}>
        {shownLabel}
        {converting && (
          <span className="expr-unit"> ({displayLengthName(shown)})</span>
        )}
      </label>
      <div className="expr-input-row">
        <input
          ref={inputRef}
          id={id}
          className="mono"
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoFocus={mayAutoFocus}
          // The preview sits under the field, so it was being read as part
          // of the field's name: "Width (X) = 30" one keystroke, "Width (X)
          // Unknown identifier "w"" the next — a name that changes as you
          // type. Point the name at the label text and let the preview be a
          // description that announces itself when it changes.
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : `${id}-label`}
          aria-describedby={showPreview ? `${id}-preview` : undefined}
          aria-invalid={showError || undefined}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => setTyped(null)}
          onChange={(event) => {
            const next = event.target.value;
            if (converting && stored !== undefined) {
              setTyped(next);
              onChange(storedLengthText(next, stored, shown));
            } else {
              onChange(next);
            }
          }}
        />
        {showPreview &&
          (undefinedName && definition && DefineParameterPrompt ? (
            <DefineParameterPrompt
              // A different name is a different offer, with its own value.
              key={undefinedName}
              name={undefinedName}
              initialValue={
                lastValue === undefined ? '' : formatNumber(lastValue)
              }
              noteId={`${id}-preview`}
              definition={definition}
              onDefined={() => {
                // Back to the field, which now evaluates, with the caret
                // after the name: Enter creates from here. Only from this
                // field or from nowhere (the prompt unmounted under the
                // focus): never pulled back from somewhere else meanwhile.
                const input = inputRef.current;
                const active = document.activeElement;
                if (
                  !input ||
                  (active &&
                    active !== document.body &&
                    !rootRef.current?.contains(active))
                )
                  return;
                input.focus();
                const end = input.value.length;
                input.setSelectionRange(end, end);
              }}
            />
          ) : (
            previewLine
          ))}
      </div>
    </div>
  );
}
