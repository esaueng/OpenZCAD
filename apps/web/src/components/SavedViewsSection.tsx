import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  MAX_SAVED_VIEWS,
  deleteSavedView,
  loadSavedViews,
  saveView,
  type SavedView
} from '../lib/savedViews';

export type SavedViewInput = Omit<SavedView, 'id' | 'name' | 'savedAt'>;

export interface SavedViewsSectionProps {
  projectId: string;
  /** The current view to save, or null before the viewport reports one. */
  capture(): SavedViewInput | null;
  onApply(view: SavedView): void;
  onStatus(message: string): void;
}

/**
 * The project's saved views, under the standard view tiles: each restores the
 * camera, projection, display mode and section it was saved with. It owns the
 * list and its storage so that none of it rides in the entry chunk; it loads
 * with the viewer chrome that shows it. Spans the tile grid it sits in.
 */
export function SavedViewsSection({
  projectId,
  capture,
  onApply,
  onStatus
}: SavedViewsSectionProps) {
  const [views, setViews] = useState<SavedView[]>(() =>
    loadSavedViews(projectId)
  );
  useEffect(() => setViews(loadSavedViews(projectId)), [projectId]);
  const full = views.length >= MAX_SAVED_VIEWS;

  function save() {
    const view = capture();
    if (!view) {
      onStatus('Move the view once, then save it.');
      return;
    }
    const result = saveView(projectId, view);
    if (!result.ok) {
      onStatus(result.reason);
      return;
    }
    setViews(result.views);
    onStatus(`Saved ${result.view.name}.`);
  }

  return (
    <div className="saved-views" role="group" aria-label="Saved views">
      {views.map((view) => (
        <div key={view.id} className="saved-views-row">
          <button
            type="button"
            className="saved-views-apply"
            aria-label={`Go to ${view.name}`}
            onClick={() => onApply(view)}
          >
            {view.name}
          </button>
          <button
            type="button"
            className="saved-views-delete"
            aria-label={`Delete ${view.name}`}
            onClick={() => {
              setViews(deleteSavedView(projectId, view.id));
              onStatus(`Deleted ${view.name}.`);
            }}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="saved-views-save"
        disabled={full}
        title={
          full
            ? `A project keeps up to ${MAX_SAVED_VIEWS} saved views. Delete one to save another.`
            : 'Save the camera, projection, display mode and section'
        }
        onClick={save}
      >
        <Plus size={11} aria-hidden="true" />
        Save view
      </button>
    </div>
  );
}
