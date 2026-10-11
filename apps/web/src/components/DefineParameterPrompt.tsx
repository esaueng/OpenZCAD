import { useEffect, useId, useRef, useState } from 'react';
import type { ParameterDefinition } from './forms/parameterDefinition';

interface DefineParameterPromptProps {
  /** The undefined name the field reads. */
  name: string;
  /**
   * The value to offer: the field's last value that evaluated, in the same
   * document units, so `width` typed over 80 offers `width = 80`.
   */
  initialValue: string;
  /** Id of the line that says what is missing; the field points at it. */
  noteId: string;
  definition: ParameterDefinition;
  /** Called once the parameter exists, so the field can take focus back. */
  onDefined(): void;
}

/**
 * The line under an expression field that names a parameter nobody has
 * defined yet: "`width` is not defined yet · Define width = [80] ↵". It
 * takes the place of the bare "Unknown identifier" error, and defining the
 * name lets the field evaluate without leaving the card.
 *
 * Loaded on first use: the field it sits under is in the entry chunk.
 */
export function DefineParameterPrompt({
  name,
  initialValue,
  noteId,
  definition,
  onDefined
}: DefineParameterPromptProps) {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit() {
    if (pending) return;
    const expression = value.trim();
    if (!expression) {
      setError(`Enter a value for ${name}.`);
      return;
    }
    setError(null);
    setPending(true);
    let refusal: string | null;
    try {
      refusal = await definition.define(name, expression);
    } catch {
      refusal = `${name} could not be defined.`;
    }
    // Success often unmounts this prompt before the definition returns: the
    // field evaluates as soon as the workspace renders the new parameter. The
    // field still takes focus back, from wherever the unmount left it.
    if (mounted.current) {
      setPending(false);
      setError(refusal);
    }
    if (!refusal) onDefined();
  }

  return (
    <div className="expr-define">
      <small id={noteId} className="expr-define-note">
        <code>{name}</code> is not defined yet
      </small>
      <div className="expr-define-row">
        <label htmlFor={inputId} aria-hidden="true">
          Define {name} =
        </label>
        <input
          id={inputId}
          className="mono"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Value for new parameter ${name}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            // Enter here defines the parameter; it must not reach the card,
            // whose Enter creates the feature (and is refused while this
            // field is still unresolved). Escape still cancels the card.
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              void submit();
            }
          }}
        />
        <button
          type="button"
          className="secondary expr-define-submit"
          disabled={pending}
          aria-label={`Define parameter ${name}`}
          onClick={() => void submit()}
        >
          {pending ? 'Defining…' : 'Define'}
          <kbd className="expr-define-key" aria-hidden="true">
            ↵
          </kbd>
        </button>
      </div>
      {error ? (
        <small id={errorId} className="expr-preview error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}
