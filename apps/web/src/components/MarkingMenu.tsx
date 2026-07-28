import { useEffect, useRef, useState } from 'react';
import type { ContextMenuItem } from './ContextMenu';
import {
  clampMenuOrigin,
  MARKING_DEAD_ZONE_PX,
  sectorForVector,
  sectorPosition,
  splitRadial
} from '../lib/markingMenu';

/** How far from the centre the sector labels sit. */
const RING_RADIUS = 78;
/** Ring plus enough room for a label to sit at the end of it. */
const RING_REACH = RING_RADIUS + 90;

interface MarkingMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect(itemId: string): void;
  onClose(): void;
}

/**
 * The viewport's action menu, laid out by direction.
 *
 * The menu opens on the right-click's release, because holding the right
 * button already means panning the view and that binding is worth more than
 * opening a frame earlier. So the flick is a second press: press anywhere and
 * drag outward, and the direction alone commits on release — the pointer
 * never has to reach the label. Clicking a label works too, and both paths
 * read the same ring, so the fast way is the slow way done confidently
 * rather than something separate to learn.
 *
 * Actions past the ring appear as a list below it. They are the ones a hand
 * would never learn by direction anyway, so nothing is lost by naming them.
 */
export function MarkingMenu({
  x,
  y,
  items,
  onSelect,
  onClose
}: MarkingMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [aimed, setAimed] = useState<number | null>(null);
  const { radial, overflow } = splitRadial(items);
  // Aiming is measured from where the menu actually is, so the clamped
  // centre has to be what both the layout and the flick use.
  const origin = clampMenuOrigin(
    x,
    y,
    window.innerWidth,
    window.innerHeight,
    RING_REACH
  );

  useEffect(() => {
    /**
     * A press with the menu already open is a flick: track where it points,
     * and commit on release. Releases with no travel fall in the dead zone
     * and pick nothing, which is what leaves plain clicking a label intact.
     */
    function onPointerMove(event: PointerEvent) {
      if (event.buttons === 0) {
        return;
      }
      setAimed(
        sectorForVector(
          event.clientX - origin.x,
          event.clientY - origin.y,
          radial.length
        )
      );
    }
    function onPointerUp(event: PointerEvent) {
      const sector = sectorForVector(
        event.clientX - origin.x,
        event.clientY - origin.y,
        radial.length
      );
      const item = sector === null ? null : radial[sector];
      if (item && !item.disabled) {
        onSelect(item.id);
        onClose();
      }
      setAimed(null);
    }
    function onPointerDown(event: PointerEvent) {
      if (ref.current?.contains(event.target as Node)) {
        return;
      }
      // A press inside the ring is a flick starting, not a press elsewhere.
      // The menu draws nothing between the labels, so that press lands on the
      // model behind it and would otherwise dismiss the menu before the
      // gesture it was beginning could finish.
      const reach = Math.hypot(
        event.clientX - origin.x,
        event.clientY - origin.y
      );
      if (reach > RING_REACH) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [origin.x, origin.y, radial, onSelect, onClose]);

  return (
    <div
      ref={ref}
      className="marking-menu"
      role="menu"
      aria-label="Selection actions"
      style={{ left: origin.x, top: origin.y }}
    >
      <span
        className="marking-menu-hub"
        style={{ width: MARKING_DEAD_ZONE_PX * 2, height: MARKING_DEAD_ZONE_PX * 2 }}
        aria-hidden="true"
      />
      {radial.map((item, index) => {
        const at = sectorPosition(index, radial.length, RING_RADIUS);
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`marking-menu-sector${aimed === index ? ' aimed' : ''}${
              item.danger ? ' danger' : ''
            }`}
            disabled={item.disabled}
            style={{ left: at.x, top: at.y }}
            onClick={() => {
              onSelect(item.id);
              onClose();
            }}
          >
            {item.icon && <span className="marking-menu-icon">{item.icon}</span>}
            <span className="marking-menu-label">{item.label}</span>
          </button>
        );
      })}
      {overflow.length > 0 && (
        <div className="marking-menu-overflow">
          {overflow.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`marking-menu-more${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                onSelect(item.id);
                onClose();
              }}
            >
              {item.icon && (
                <span className="marking-menu-icon">{item.icon}</span>
              )}
              <span className="marking-menu-label">{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
