import { useRef, type ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { useModalFocus } from '../lib/useModalFocus';

function ExportUnavailable({ onClose }: { onClose(): void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });
  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-unavailable-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="export-unavailable-title">Export unavailable</h2>
        <p role="alert">
          The export panel could not load. Close this dialog to keep working.
          Save your work before reloading the page to try again.
        </p>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export function ExportDialogBoundary({
  children,
  onClose
}: {
  children: ReactNode;
  onClose(): void;
}) {
  // A missing deployment chunk must not unmount the document's workspace.
  return (
    <ErrorBoundary
      label="Mesh export"
      fallback={<ExportUnavailable onClose={onClose} />}
    >
      {children}
    </ErrorBoundary>
  );
}
