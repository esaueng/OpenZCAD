import { useId } from 'react';
import { previewExpression } from '../lib/model';

interface ExprInputProps {
  label: string;
  value: string;
  scope: Record<string, number>;
  onChange(value: string): void;
  placeholder?: string;
  /** Allow an empty / zero-result field without flagging it (e.g. offsets). */
  optional?: boolean;
  /** Focus this field when the form opens so typing replaces the default. */
  autoFocus?: boolean;
}

/**
 * Text input for a parametric scalar. Accepts plain numbers or expressions
 * over the parameter table ("w / 2 + 5") and previews the evaluated result
 * inline so broken references are visible before the model rebuilds.
 */
export function ExprInput({ label, value, scope, onChange, placeholder, optional, autoFocus }: ExprInputProps) {
  const id = useId();
  const preview = previewExpression(value, scope);
  const showError = !preview.ok && !(optional && value.trim().length === 0);
  const isPlainNumber = /^\s*-?(?:\d+\.?\d*|\.\d+)\s*$/.test(value);

  return (
    <label className="field expr-field" htmlFor={id}>
      <span>{label}</span>
      <div className="expr-input-row">
        <input
          id={id}
          className="mono"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onChange(event.target.value)}
        />
        {!isPlainNumber && (
          <small className={`expr-preview ${showError ? 'error' : ''}`}>{preview.text}</small>
        )}
      </div>
    </label>
  );
}
