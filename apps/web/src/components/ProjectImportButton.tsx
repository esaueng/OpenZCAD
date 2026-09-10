import { useRef } from 'react';
import { Upload } from 'lucide-react';

export function ProjectImportButton({
  onImport,
  disabled = false,
  className = 'topbar-menu-item',
  hint
}: {
  onImport(file: File): void;
  disabled?: boolean;
  className?: string;
  /** A second line under the label, for the menu's format column. */
  hint?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload size={14} aria-hidden="true" />
        <span>Import project…</span>
        {hint ? <small>{hint}</small> : null}
      </button>
      <input
        ref={input}
        type="file"
        accept=".openzcad"
        aria-label="Import project backup"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) onImport(file);
        }}
      />
    </>
  );
}
