import { useRef } from 'react';
import { useModalFocus } from '../lib/useModalFocus';

interface ShortcutsOverlayProps {
  onClose(): void;
}

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Tools',
    rows: [
      ['B', 'Box'],
      ['C', 'Cylinder'],
      ['S', 'Sketch'],
      ['E', 'Extrude'],
      ['R', 'Revolve'],
      ['U', 'Union'],
      ['X', 'Subtract'],
      ['I', 'Intersect'],
      ['M', 'Move']
    ]
  },
  {
    title: 'View',
    rows: [
      ['1', 'Front view'],
      ['2', 'Top view'],
      ['3', 'Right view'],
      ['4', 'Isometric view'],
      ['F', 'Fit view'],
      ['G', 'Toggle grid'],
      ['W', 'Cycle display mode'],
      ['Double-click', 'Fit view']
    ]
  },
  {
    title: 'Edit',
    rows: [
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Shift+Z', 'Redo'],
      ['Ctrl+S', 'Save revision'],
      ['Del', 'Delete selected feature'],
      ['Esc', 'Cancel / close panel'],
      ['Shift+Click', 'Add body to selection']
    ]
  },
  {
    title: 'General',
    rows: [
      ['Ctrl+K', 'Command palette'],
      ['?', 'This cheat sheet'],
      ['Enter', 'Confirm form']
    ]
  }
];

/** "?" keyboard cheat sheet. */
export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Opened by "?" from the workspace, so nothing inside has focus yet.
  useModalFocus(dialogRef, { autoFocus: true });

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="shortcuts-card"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={dialogRef}
      >
        <div className="shortcuts-header">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="shortcuts-grid">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="section-title">{group.title}</h3>
              <dl>
                {group.rows.map(([key, action]) => (
                  <div key={key} className="shortcut-row">
                    <dt>
                      <kbd>{key}</kbd>
                    </dt>
                    <dd>{action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
