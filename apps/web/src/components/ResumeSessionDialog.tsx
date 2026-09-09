import { useRef } from 'react';
import type { ProjectWorkspaceSession } from '@openzcad/shared';
import { useModalFocus } from '../lib/useModalFocus';

export function ResumeSessionDialog({
  session,
  alsoOpen = false,
  onChoose
}: {
  session: ProjectWorkspaceSession;
  alsoOpen?: boolean;
  onChoose(resume: boolean): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { autoFocus: true });
  return (
    <div className="modal-backdrop">
      <div
        className="save-revision-dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-session-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onChoose(false);
          }
        }}
      >
        <h2 id="resume-session-title">Resume where you left off?</h2>
        <p>
          {session.deviceLabel} · {new Date(session.updatedAt).toLocaleString()}
        </p>
        <p>
          Restore your view, selection, and workspace panels. Your latest
          project and undo history are available with either option.
        </p>
        {alsoOpen && <p>This project is also open in another session.</p>}
        <div className="save-revision-actions">
          <button type="button" onClick={() => onChoose(false)}>
            Open with default view
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onChoose(true)}
          >
            Resume session
          </button>
        </div>
      </div>
    </div>
  );
}
