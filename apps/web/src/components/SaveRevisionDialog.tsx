import { useRef, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { MAX_CHECKPOINT_REASON_LENGTH } from '@openzcad/shared';
import { useModalFocus } from '../lib/useModalFocus';

export interface SaveRevisionDialogProps {
  /** Shown so the user can see which project they are marking. */
  projectName: string;
  onCancel(): void;
  onSave(name: string): void;
}

/**
 * Names a save point as it is made.
 *
 * Ctrl+S deliberately does not open this. Saving is a reflex — interrupting it
 * with a prompt every time would tax the common case to serve the rare one —
 * so the quick save keeps its automatic "Manual save" and naming is its own
 * gesture. The name is the only thing the history panel shows for a save
 * afterwards, which is what makes it worth typing: "before the fillet pass"
 * is a place to come back to, and "Manual save" is a timestamp.
 */
export function SaveRevisionDialog({
  projectName,
  onCancel,
  onSave
}: SaveRevisionDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: inputRef });

  const trimmed = name.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed) {
      onSave(trimmed);
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="save-revision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-revision-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="save-revision-dialog-title">
          <Save size={16} aria-hidden="true" />
          Name this save
        </h2>
        <p>
          Marks the current state of {projectName} as a save point you can
          restore or branch from later.
        </p>
        <form onSubmit={submit}>
          <label className="save-revision-name">
            <span>Name</span>
            <input
              ref={inputRef}
              type="text"
              value={name}
              // The server refuses a longer reason, so the field that types it
              // stops at the same place rather than letting a save be composed
              // and then rejected.
              maxLength={MAX_CHECKPOINT_REASON_LENGTH}
              placeholder="Before the fillet pass"
              aria-label="Save name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="save-revision-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            {/* An unnamed named-save is just Ctrl+S with extra steps. */}
            <button type="submit" className="primary" disabled={!trimmed}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
