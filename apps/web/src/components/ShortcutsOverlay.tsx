import { useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  liveKeyboardGroups,
  POINTER_CONTROL_GROUPS
} from '../lib/controlReference';
import { useKeymap } from '../lib/keymap';
import { useModalFocus } from '../lib/useModalFocus';

interface ShortcutsOverlayProps {
  onClose(): void;
  onTour?(): void;
  tourDeferred?: boolean;
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
export function ShortcutsOverlay({
  onClose,
  onTour,
  tourDeferred = false
}: ShortcutsOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () =>
      setMoreBelow(list.scrollHeight - list.scrollTop > list.clientHeight + 2);
    measure();
    list.addEventListener('scroll', measure, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(list);
    return () => {
      list.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);
  // The keys as the user has them, remaps included.
  const keyboardGroups = liveKeyboardGroups(useKeymap());

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
          <h2 id="shortcuts-title">Help &amp; controls</h2>
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
          ref={listRef}
          tabIndex={0}
          role="region"
          aria-label="Controls list"
        >
          <section>
            <h3 className="section-title">Modeling guide</h3>
            <ol className="shortcuts-guide">
              <li>
                <strong>Create:</strong> choose Box for a solid, or Sketch, a
                plane and a closed profile. Extrude turns the profile into a
                solid.
              </li>
              <li>
                <strong>Edit:</strong> select a face or edge for the edits it
                supports. Use the value labels or Options for precise
                dimensions.
              </li>
              <li>
                <strong>Check:</strong> inspect the preview before Done. Cancel
                discards the preview; Undo restores the previous operation.
              </li>
              <li>
                <strong>Refine:</strong> open History to change feature values.
                Objects controls visibility; Parameters names reusable
                dimensions.
              </li>
              <li>
                <strong>Keep:</strong> autosave stays on this device. File saves
                a revision or exports STEP, a printing mesh or a complete
                project backup.
              </li>
            </ol>
            {onTour && (
              <button type="button" className="secondary" onClick={onTour}>
                {tourDeferred
                  ? 'Resume modeling guide after this command'
                  : 'Open modeling guide'}
              </button>
            )}
          </section>
          {[...keyboardGroups, ...POINTER_CONTROL_GROUPS].map((group) => (
            <section key={group.title}>
              <h3 className="section-title">{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={item.id} className="shortcut-row">
                    <dt>
                      {item.action}
                      {item.id === 'move'
                        ? ' (Build mode)'
                        : item.id === 'measure'
                          ? ' (View / Tweak)'
                          : ''}
                    </dt>
                    <dd>
                      <span className="shortcut-key-sequence">
                        {item.keys.length > 0
                          ? item.keys.map((key) => <kbd key={key}>{key}</kbd>)
                          : 'Unassigned'}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        {moreBelow && (
          <p className="shortcuts-scroll-cue">Scroll for more controls ↓</p>
        )}
      </div>
    </div>
  );
}
