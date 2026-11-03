import { useEffect, useRef, useState } from 'react';
import { MAX_ASSEMBLY_NAME_LENGTH } from '@openzcad/shared';

interface AssemblyNameFieldProps {
  value: string;
  label: string;
  /** Called with the trimmed name when it changed and is not empty. */
  onCommit(name: string): void;
  /** After a commit or a cancel: an inline rename closes itself. */
  onDone?(): void;
  autoFocus?: boolean;
  /** Saves the name even when it is the one shown (a new entry's default). */
  commitUnchanged?: boolean;
  className?: string;
}

/**
 * A name edited in place: Enter or leaving the field saves it, Escape puts
 * the old name back. An empty name is never saved.
 */
export function AssemblyNameField({
  value,
  label,
  onCommit,
  onDone,
  autoFocus = false,
  commitUnchanged = false,
  className = 'assembly-name-field'
}: AssemblyNameFieldProps) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.select();
  }, [autoFocus]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      onDone?.();
      return;
    }
    const name = draft.trim();
    if (name && (commitUnchanged || name !== value)) onCommit(name);
    else setDraft(value);
    onDone?.();
  };

  return (
    <input
      ref={ref}
      className={className}
      aria-label={label}
      value={draft}
      maxLength={MAX_ASSEMBLY_NAME_LENGTH}
      autoFocus={autoFocus}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
