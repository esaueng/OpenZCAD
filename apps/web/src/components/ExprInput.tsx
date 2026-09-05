import { useId } from 'react';
import { previewExpression } from '../lib/model';
import { useFieldAutoFocus } from './forms/fieldAutoFocus';

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
  error
}: ExprInputProps) {
  const id = useId();
  const mayAutoFocus = useFieldAutoFocus(autoFocus);
  const preview = previewExpression(value, scope);
  const showError =
    Boolean(error) || (!preview.ok && !(optional && value.trim().length === 0));
  const isPlainNumber = /^\s*-?(?:\d+\.?\d*|\.\d+)\s*$/.test(value);
  const showPreview = !isPlainNumber || showError;

  return (
    <label className="field expr-field" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <div className="expr-input-row">
        <input
          id={id}
          className="mono"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoFocus={mayAutoFocus}
          // The preview sits inside this label, so it was being read as part
          // of the field's name: "Width (X) = 30" one keystroke, "Width (X)
          // Unknown identifier "w"" the next — a name that changes as you
          // type. Point the name at the label text and let the preview be a
          // description that announces itself when it changes.
          aria-labelledby={`${id}-label`}
          aria-describedby={showPreview ? `${id}-preview` : undefined}
          aria-invalid={showError || undefined}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onChange(event.target.value)}
        />
        {showPreview && (
          <small
            id={`${id}-preview`}
            className={`expr-preview ${showError ? 'error' : ''}`}
          >
            {error ?? preview.text}
          </small>
        )}
      </div>
    </label>
  );
}
