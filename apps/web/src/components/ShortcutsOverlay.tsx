import { useRef } from 'react';
import { X } from 'lucide-react';
import {
  KEYBOARD_CONTROL_GROUPS,
  POINTER_CONTROL_GROUPS
} from '../lib/controlReference';
import { useModalFocus } from '../lib/useModalFocus';

interface ShortcutsOverlayProps {
  onClose(): void;
}

/**
 * "?" control reference.
 *
 * Keyboard only, until now — which left the mouse bindings undiscoverable
 * anywhere in the product. Orbit is Shift+drag and pan is right-drag; neither
 * is guessable, and left-drag on empty space box-selects instead, so a new
 * user who tries the obvious gesture clears their selection rather than
 * turning the model.
 */
export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Opened by "?" from the workspace, so nothing inside has focus yet.
  // The workspace keymap toggles and closes this sheet, so it must still
  // reach the map while the sheet is up.
  useModalFocus(dialogRef, { autoFocus: true, workspaceKeys: true });

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
        // Named by its title: it lists pointer controls too, and was
        // announced as "Keyboard shortcuts" under a heading reading Controls.
        aria-labelledby="shortcuts-title"
        ref={dialogRef}
      >
        <div className="shortcuts-header">
          <h2 id="shortcuts-title">Controls</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        {/* The scroller takes focus: Close was the only stop, so arrows and
            Page Down could not reach the half of the list below the fold. */}
        <div
          className="shortcuts-grid"
          tabIndex={0}
          role="region"
          aria-label="Controls list"
        >
          {[...KEYBOARD_CONTROL_GROUPS, ...POINTER_CONTROL_GROUPS].map(
            (group) => (
              <section key={group.title}>
                <h3 className="section-title">{group.title}</h3>
                <dl>
                  {group.items.map((item) => (
                    <div key={item.id} className="shortcut-row">
                      <dt>
                        <span className="shortcut-key-sequence">
                          {item.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                        </span>
                      </dt>
                      <dd>{item.action}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )
          )}
        </div>
      </div>
    </div>
  );
}
