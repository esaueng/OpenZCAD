import { useEffect, useId, useRef } from 'react';
import { useMenuKeyboard } from '../../lib/useMenuKeyboard';
import type { ContextMenuState } from '../ContextMenu';

interface CompactActionSheetProps {
  menu: ContextMenuState;
  /** Fading out after it closed: still drawn, but deaf to input. */
  closing?: boolean;
  onSelect(itemId: string): void;
  onClose(): void;
}

/**
 * A context menu as the compact workspace shows one (U12 slice 5): an
 * action sheet over the foot of the screen, opened by a long press on the
 * model or a panel row. The items are the very ones the regular workspace's
 * right-click menu lists (`viewportMenu.ts` and App's menu builders), each a
 * full-width row a finger can hit; the heading names what they act on, and
 * Cancel, a tap outside or Escape puts it away.
 */
export default function CompactActionSheet({
  menu,
  closing = false,
  onSelect,
  onClose
}: CompactActionSheetProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  useMenuKeyboard(ref);

  useEffect(() => {
    if (closing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closing, onClose]);

  return (
    <div
      className={`compact-action-sheet-scrim${closing ? ' closing' : ''}`}
      inert={closing}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="compact-action-sheet"
        role="menu"
        aria-labelledby={menu.heading ? headingId : undefined}
        aria-label={menu.heading ? undefined : 'Actions'}
        tabIndex={-1}
      >
        {menu.heading ? (
          <div id={headingId} className="compact-action-sheet-heading">
            {menu.heading}
          </div>
        ) : null}
        <div className="compact-action-sheet-items">
          {menu.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`compact-action-sheet-item${
                item.danger ? ' is-danger' : ''
              }${item.section ? ' is-section' : ''}`}
              disabled={item.disabled}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              onClick={() => {
                onSelect(item.id);
                onClose();
              }}
            >
              {item.icon ? (
                <span className="compact-action-sheet-icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="compact-action-sheet-label">
                <span>{item.label}</span>
                {item.detail ? (
                  <span className="compact-action-sheet-detail">
                    {item.detail}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          role="menuitem"
          className="compact-action-sheet-item is-cancel"
          onClick={onClose}
        >
          <span className="compact-action-sheet-label">
            <span>Cancel</span>
          </span>
        </button>
      </div>
    </div>
  );
}
