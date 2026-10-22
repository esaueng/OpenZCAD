import { useEffect, useRef, type ReactNode } from 'react';

/**
 * An Objects row's name as a field: Enter or leaving the field keeps the new
 * name, Escape keeps the old one. An empty or unchanged name is no edit at
 * all, so it adds nothing to history. History's own rename field behaves
 * the same way.
 */
export function ObjectRenameField({
  name,
  label,
  icon,
  onCommit,
  onDone
}: {
  name: string;
  /** The field's accessible name: "Rename body Box 1". */
  label: string;
  icon: ReactNode;
  onCommit(name: string): void;
  /** `refocus`: the field closed from the keyboard, so the row takes focus. */
  onDone(refocus: boolean): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  function finish(keep: boolean, refocus: boolean) {
    // Enter unmounts the field, and the blur that follows must not commit a
    // second time.
    if (settled.current) return;
    settled.current = true;
    const next = inputRef.current?.value.trim() ?? '';
    if (keep && next && next !== name) onCommit(next);
    onDone(refocus);
  }
  return (
    <span className="feature-row-rename">
      <span className="feature-icon">{icon}</span>
      <input
        ref={inputRef}
        type="text"
        defaultValue={name}
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            // Escape here cancels the rename, not the workspace's selection.
            event.stopPropagation();
            finish(event.key === 'Enter', true);
          }
        }}
        onBlur={() => finish(true, false)}
      />
    </span>
  );
}
