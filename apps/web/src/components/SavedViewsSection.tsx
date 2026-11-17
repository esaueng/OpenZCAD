import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  MAX_SAVED_VIEWS,
  SAVED_VIEW_NAME_MAX,
  deleteSavedView,
  loadSavedViews,
  renameSavedView,
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
  // The view just saved, named in place: "+ Save view" saved "View 1" with
  // no way to call it anything else, and a name typed afterwards went to the
  // workspace's shortcuts (S armed Sketch) (I54).
  const [naming, setNaming] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // Enter, Escape and the blur that follows them all end one naming; only
  // the first counts, so Escape never saves what the blur still holds.
  const settledRef = useRef(false);
  useEffect(() => {
    if (naming) {
      settledRef.current = false;
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [naming]);
  // Ended from the keyboard, the field hands focus to its row's button
  // rather than letting it fall to the page.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  useEffect(() => {
    if (!refocus) return;
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-saved-view]'
      ) ?? []
    )
      .find((button) => button.dataset.savedView === refocus)
      ?.focus();
    setRefocus(null);
  }, [refocus]);

  function settle(view: SavedView, keyboard: boolean): boolean {
    if (settledRef.current) return false;
    settledRef.current = true;
    setNaming(null);
    if (keyboard) setRefocus(view.id);
    return true;
  }

  function finishNaming(view: SavedView, name: string, keyboard = false) {
    if (!settle(view, keyboard)) return;
    if (name.trim() === '' || name.trim() === view.name) return;
    const renamed = renameSavedView(projectId, view.id, name);
    if (!renamed) {
      onStatus(
        `Could not rename ${view.name}: this browser is not saving views.`
      );
      return;
    }
    setViews(renamed);
    const saved = renamed.find((entry) => entry.id === view.id);
    onStatus(`Renamed ${view.name} to ${saved?.name ?? name.trim()}.`);
  }

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
    setNaming(result.view.id);
    onStatus(`Saved ${result.view.name} · type a name, or Enter to keep it.`);
  }

  return (
    <div
      ref={listRef}
      className="saved-views"
      role="group"
      aria-label="Saved views"
    >
      {views.map((view) => (
        <div key={view.id} className="saved-views-row">
          {naming === view.id ? (
            <input
              ref={nameRef}
              className="saved-views-name"
              aria-label={`Name ${view.name}`}
              defaultValue={view.name}
              maxLength={SAVED_VIEW_NAME_MAX}
              onKeyDown={(event) => {
                // The workspace's single-key shortcuts must not see a name.
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  finishNaming(view, event.currentTarget.value, true);
                } else if (event.key === 'Escape') {
                  // Keeps the name it had; the flyout stays open.
                  event.preventDefault();
                  settle(view, true);
                }
              }}
              onBlur={(event) => finishNaming(view, event.currentTarget.value)}
            />
          ) : (
            <button
              type="button"
              className="saved-views-apply"
              data-saved-view={view.id}
              aria-label={`Go to ${view.name}`}
              onClick={() => onApply(view)}
              onDoubleClick={() => setNaming(view.id)}
            >
              {view.name}
            </button>
          )}
          <button
            type="button"
            className="saved-views-delete"
            aria-label={`Delete ${view.name}`}
            onClick={() => {
              const remaining = deleteSavedView(projectId, view.id);
              if (!remaining) {
                onStatus(
                  `Could not delete ${view.name}: this browser is not saving views.`
                );
                return;
              }
              setViews(remaining);
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
