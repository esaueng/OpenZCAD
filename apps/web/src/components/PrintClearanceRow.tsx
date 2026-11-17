import { useEffect, useId, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { ParamValue, UnitSystem } from '@openzcad/shared';

export interface PrintClearanceState {
  /** The stored value: a length in document units or an expression. */
  stored: ParamValue | undefined;
  /** What it resolves to, in document units; null when unset or refused. */
  value: number | null;
  /** Why the stored value does not resolve, if it does not. */
  error: string | null;
}

export interface PrintClearanceRowProps {
  clearance: PrintClearanceState;
  units: UnitSystem;
  /** Sets (or, with null, clears) the clearance; answers with a refusal. */
  onSet?(value: ParamValue | null): string | null | Promise<string | null>;
}

const UNIT_LABEL: Record<UnitSystem, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  inch: 'in'
};

function storedText(stored: ParamValue | undefined): string {
  return stored === undefined ? '' : String(stored);
}

function rounded(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/**
 * L09: the document's print clearance, under the parameters. Threads that
 * leave their own clearance unset and gears that leave their backlash unset
 * build from it; blank means none.
 */
export function PrintClearanceRow({
  clearance,
  units,
  onSet
}: PrintClearanceRowProps) {
  const [draft, setDraft] = useState(storedText(clearance.stored));
  const [error, setError] = useState<string | null>(null);
  const feedbackId = useId();
  const edits = useRef(0);
  const stored = storedText(clearance.stored);
  // A change from elsewhere (undo, another device) replaces an untouched draft.
  useEffect(() => {
    setDraft(stored);
    setError(null);
  }, [stored]);

  async function submit(value: ParamValue | null) {
    if (!onSet) return;
    const submitted = ++edits.current;
    let refusal: string | null;
    try {
      refusal = await onSet(value);
    } catch {
      refusal = 'The print clearance could not be changed.';
    }
    if (submitted !== edits.current) return;
    setError(refusal ? `${refusal} Not changed.` : null);
  }

  const unit = UNIT_LABEL[units];
  const shown = error ?? clearance.error;
  return (
    <form
      className="param-create"
      onSubmit={(event) => {
        event.preventDefault();
        const text = draft.trim();
        if (text === stored) return;
        const numeric = Number(text);
        void submit(
          text === '' ? null : Number.isFinite(numeric) ? numeric : text
        );
      }}
    >
      <div className="param-add">
        <span className="param-value">Print clearance</span>
        <input
          className="mono"
          placeholder={`none (${unit})`}
          value={draft}
          spellCheck={false}
          readOnly={!onSet}
          aria-label="Print clearance"
          aria-invalid={shown ? true : undefined}
          aria-describedby={feedbackId}
          onChange={(event) => {
            edits.current += 1;
            setError(null);
            setDraft(event.target.value);
          }}
        />
        {onSet && (
          <button
            type="submit"
            className="icon-button"
            title="Set print clearance"
            aria-label="Set print clearance"
          >
            <Check size={13} aria-hidden="true" />
          </button>
        )}
        {onSet && clearance.stored !== undefined && (
          <button
            type="button"
            className="icon-button"
            title="Clear print clearance"
            aria-label="Clear print clearance"
            onClick={() => void submit(null)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {shown ? (
        <p id={feedbackId} className="parameter-feedback error" role="alert">
          {shown}
        </p>
      ) : (
        <p id={feedbackId} className="muted sidebar-hint">
          {clearance.value === null
            ? 'Radial gap for printed fits. Threads and gears without their own clearance or backlash use it.'
            : `${rounded(clearance.value)} ${unit} radial gap for threads and gears without their own clearance or backlash.`}
        </p>
      )}
    </form>
  );
}
