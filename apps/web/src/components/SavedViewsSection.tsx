import { Plus, X } from 'lucide-react';

export interface SavedViewsSectionProps {
  views: readonly { id: string; name: string }[];
  /** Why saving is unavailable right now, shown instead of the save button. */
  saveDisabledReason?: string | null;
  onSave(): void;
  onApply(viewId: string): void;
  onDelete(viewId: string): void;
}

/**
 * The project's saved views, under the standard view tiles: each restores the
 * camera, projection, display mode and section it was saved with. Spans the
 * tile grid it sits in.
 */
export function SavedViewsSection({
  views,
  saveDisabledReason = null,
  onSave,
  onApply,
  onDelete
}: SavedViewsSectionProps) {
  return (
    <div className="saved-views" role="group" aria-label="Saved views">
      {views.map((view) => (
        <div key={view.id} className="saved-views-row">
          <button
            type="button"
            className="saved-views-apply"
            aria-label={`Go to ${view.name}`}
            onClick={() => onApply(view.id)}
          >
            {view.name}
          </button>
          <button
            type="button"
            className="saved-views-delete"
            aria-label={`Delete ${view.name}`}
            onClick={() => onDelete(view.id)}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="saved-views-save"
        disabled={saveDisabledReason !== null}
        title={
          saveDisabledReason ??
          'Save the camera, projection, display mode and section'
        }
        onClick={onSave}
      >
        <Plus size={11} aria-hidden="true" />
        Save view
      </button>
    </div>
  );
}
