import { useEffect, useRef } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Folder,
  FolderMinus,
  FolderPlus,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react';
import type { ProjectStatus } from '@openzcad/shared';
import type { LibraryFolder } from '../lib/libraryFolders';

/**
 * What can be done to every selected project at once, floating over the shelf
 * while anything is selected. The actions follow the shelf: projects can be
 * filed, pinned, archived or trashed; archived ones restored or trashed;
 * trashed ones restored or destroyed.
 */
export function LibrarySelectionBar({
  count,
  total,
  shelf,
  busy,
  folders,
  inFolderId,
  allPinned,
  moveMenuOpen,
  onMoveMenuOpenChange,
  onSelectAll,
  onClear,
  onMoveToFolder,
  onNewFolder,
  onRemoveFromFolder,
  onPin,
  onMoveToShelf,
  onDeleteForever
}: {
  count: number;
  /** Projects on screen, for "Select all". */
  total: number;
  shelf: ProjectStatus;
  busy: boolean;
  folders: readonly LibraryFolder[];
  /** The folder being shown, whose projects can be taken back out. */
  inFolderId: string | null;
  allPinned: boolean;
  moveMenuOpen: boolean;
  onMoveMenuOpenChange(open: boolean): void;
  onSelectAll(): void;
  onClear(): void;
  onMoveToFolder(folderId: string): void;
  onNewFolder(): void;
  onRemoveFromFolder(): void;
  onPin(pinned: boolean): void;
  onMoveToShelf(status: ProjectStatus): void;
  onDeleteForever(): void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The menu takes focus as it opens, however it was opened (its own button,
  // or a card's "Move to folder…"): its items are not tab stops.
  useEffect(() => {
    if (moveMenuOpen) {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [moveMenuOpen]);

  useEffect(() => {
    if (!moveMenuOpen) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.start-selection-move')
      ) {
        return;
      }
      onMoveMenuOpenChange(false);
    };
    globalThis.document.addEventListener('pointerdown', dismiss, true);
    return () =>
      globalThis.document.removeEventListener('pointerdown', dismiss, true);
  }, [moveMenuOpen, onMoveMenuOpenChange]);

  const plural = count === 1 ? 'project' : 'projects';
  const targets = folders.filter((folder) => folder.id !== inFolderId);
  return (
    <div
      className="start-selection-bar"
      role="toolbar"
      aria-label={`${count} ${plural} selected`}
    >
      <span className="start-selection-count" aria-live="polite">
        {count} selected
      </span>
      {count < total && (
        <button
          type="button"
          className="start-selection-link"
          onClick={onSelectAll}
        >
          Select all {total}
        </button>
      )}
      <span className="start-selection-divider" aria-hidden="true" />
      {shelf === 'active' && (
        <>
          <div className="start-selection-move">
            <button
              type="button"
              className="start-selection-action"
              aria-haspopup="menu"
              aria-expanded={moveMenuOpen}
              disabled={busy}
              onClick={() => onMoveMenuOpenChange(!moveMenuOpen)}
            >
              <Folder size={13} aria-hidden="true" />
              Move to
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            {moveMenuOpen && (
              <div
                ref={menuRef}
                className="start-tile-menu start-selection-menu"
                role="menu"
                aria-label="Move to folder"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    onMoveMenuOpenChange(false);
                    return;
                  }
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLElement>(
                      '[role="menuitem"]'
                    )
                  );
                  const at = items.indexOf(
                    globalThis.document.activeElement as HTMLElement
                  );
                  const next =
                    event.key === 'ArrowDown'
                      ? (at + 1) % items.length
                      : event.key === 'ArrowUp'
                        ? (at <= 0 ? items.length : at) - 1
                        : -1;
                  if (next >= 0) {
                    event.preventDefault();
                    items[next]?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={onNewFolder}
                >
                  <FolderPlus size={13} aria-hidden="true" />
                  New folder
                </button>
                {targets.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    title={folder.name}
                    onClick={() => onMoveToFolder(folder.id)}
                  >
                    <Folder size={13} aria-hidden="true" />
                    <span className="start-selection-menu-name">
                      {folder.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {inFolderId && (
            <button
              type="button"
              className="start-selection-action"
              disabled={busy}
              onClick={onRemoveFromFolder}
            >
              <FolderMinus size={13} aria-hidden="true" />
              Take out
            </button>
          )}
          <button
            type="button"
            className="start-selection-action"
            disabled={busy}
            onClick={() => onPin(!allPinned)}
          >
            {allPinned ? (
              <PinOff size={13} aria-hidden="true" />
            ) : (
              <Pin size={13} aria-hidden="true" />
            )}
            {allPinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            type="button"
            className="start-selection-action"
            disabled={busy}
            onClick={() => onMoveToShelf('archived')}
          >
            <Archive size={13} aria-hidden="true" />
            Archive
          </button>
        </>
      )}
      {shelf !== 'active' && (
        <button
          type="button"
          className="start-selection-action"
          disabled={busy}
          onClick={() => onMoveToShelf('active')}
        >
          {shelf === 'deleted' ? (
            <RotateCcw size={13} aria-hidden="true" />
          ) : (
            <ArchiveRestore size={13} aria-hidden="true" />
          )}
          {shelf === 'deleted' ? 'Restore' : 'Move to projects'}
        </button>
      )}
      {shelf === 'deleted' ? (
        <button
          type="button"
          className="start-selection-action is-destructive"
          disabled={busy}
          onClick={onDeleteForever}
        >
          <Trash2 size={13} aria-hidden="true" />
          Delete forever
        </button>
      ) : (
        <button
          type="button"
          className="start-selection-action is-destructive"
          disabled={busy}
          onClick={() => onMoveToShelf('deleted')}
        >
          <Trash2 size={13} aria-hidden="true" />
          Move to trash
        </button>
      )}
      <button
        type="button"
        className="start-selection-clear"
        aria-label="Clear selection"
        title="Clear selection (Esc)"
        onClick={onClear}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
