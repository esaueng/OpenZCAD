import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import type { FieldQuantity } from '@openzcad/document-core';
import { formatNumber, previewExpression } from '../lib/model';
import type { DefineParameterPrompt as DefineParameterPromptComponent } from './DefineParameterPrompt';
import { useFieldAutoFocus } from './forms/fieldAutoFocus';
import { useParameterDefinition } from './forms/parameterDefinition';

// The define prompt is off the entry chunk: the field is in it, and the prompt
// only appears once someone types a name that is not a parameter yet. It is
// fetched when a field that could offer it mounts, and rendered only once
// loaded — never behind a Suspense fallback, which Tab would skip past, and
// never by swapping a lazy wrapper for the loaded component, which would
// remount it and drop a value being typed. Until then, or if the chunk will
// not load, the field shows the plain error it always did.
let loadedPrompt: ComponentType<
  Parameters<typeof DefineParameterPromptComponent>[0]
> | null = null;
let promptLoad: Promise<void> | null = null;

function loadDefineParameterPrompt(): Promise<void> {
  promptLoad ??= import('./DefineParameterPrompt').then(
    (module) => {
      loadedPrompt = module.DefineParameterPrompt;
    },
    () => {
      // A field mounted later tries again.
      promptLoad = null;
    }
  );
  return promptLoad;
}

/**
 * The loaded prompt component while `wanted`. Loading starts as soon as a
 * field that could offer it mounts (`available`): a card's fields mount when
 * it opens, well before a name can be typed into one and Tab pressed after it.
 */
function useDefineParameterPrompt(available: boolean, wanted: boolean) {
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (!available || loadedPrompt) return;
    let live = true;
    void loadDefineParameterPrompt().then(() => {
      if (live && loadedPrompt) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [available]);
  return wanted ? loadedPrompt : null;
}

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
  const preview = previewExpression(value, scope, quantity);
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
  const isPlainNumber = /^\s*-?(?:\d+\.?\d*|\.\d+)\s*$/.test(value);
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
        {label}
      </label>
      <div className="expr-input-row">
        <input
          ref={inputRef}
          id={id}
          className="mono"
          value={value}
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
          onChange={(event) => onChange(event.target.value)}
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
