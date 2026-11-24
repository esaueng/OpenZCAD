import { Eye, GitBranch, History, X } from 'lucide-react';

export interface SaveStatePreviewNoticeProps {
  /** The save point's name, as the versions list shows it. */
  label: string;
  /** When it was saved (ISO). */
  createdAt: string;
  /** Bodies the saved version builds, so a glance says what changed. */
  bodyCount: number;
  /**
   * Recovered from an encrypted project's signed history (ADR-024): it
   * offers no Restore, only Branch and Close.
   */
  recovered?: boolean;
  /** Absent where the project cannot be edited: a viewer previews and branches. */
  onRestore?(): void;
  onBranch(): void;
  onClose(): void;
}

/**
 * L03 read-only preview: says which saved version the viewport is showing
 * and offers the three ways out. Editing stays refused until it closes, so
 * nothing done while looking can land on either the save or the project.
 */
export function SaveStatePreviewNotice({
  label,
  createdAt,
  bodyCount,
  recovered = false,
  onRestore,
  onBranch,
  onClose
}: SaveStatePreviewNoticeProps) {
  return (
    <div
      className="save-preview-notice"
      role="region"
      aria-label="Save preview"
    >
      <span className="save-preview-notice-line">
        <Eye size={14} aria-hidden="true" />
        <strong>Previewing “{label}”</strong>
        <span className="save-preview-notice-detail">
          Saved {new Date(createdAt).toLocaleString()} · {bodyCount}{' '}
          {bodyCount === 1 ? 'body' : 'bodies'} · read only
          {recovered ? ' · recovered from signed history' : ''}
        </span>
      </span>
      <span className="save-preview-notice-actions">
        {onRestore ? (
          <button
            type="button"
            className="edit-refusal-action is-primary"
            onClick={onRestore}
          >
            <History size={12} aria-hidden="true" />
            Restore
          </button>
        ) : null}
        <button
          type="button"
          className="edit-refusal-action"
          onClick={onBranch}
        >
          <GitBranch size={12} aria-hidden="true" />
          Branch
        </button>
        <button type="button" className="edit-refusal-action" onClick={onClose}>
          <X size={12} aria-hidden="true" />
          Close preview
        </button>
      </span>
    </div>
  );
}
