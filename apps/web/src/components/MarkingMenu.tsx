import { useEffect, useRef, useState } from 'react';
import type { ContextMenuItem } from './ContextMenu';
import {
  clampMenuOrigin,
  MARKING_DEAD_ZONE_PX,
  sectorForVector,
  sectorPosition
} from '../lib/markingMenu';

/** How far from the centre the slots sit. */
const RING_RADIUS = 96;
/** Ring plus half a slot and a margin, so no slot can fall off screen. */
const RING_REACH = RING_RADIUS + 48;

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
 * never has to reach the slot. Clicking a slot works too, and both paths read
 * the same ring, so the fast way is the slow way done confidently rather than
 * something separate to learn.
 *
 * The slots carry icons alone. Names would put eight labelled boxes over the
 * model at the moment the model is what you are pointing at, so instead the
 * hub names one thing: whatever a release would run. It sits dead centre,
 * where the eye already is at the start of a flick, and it carries the
 * action's shortcut with it so the ring teaches the faster path rather than
 * only being it.
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
  const [hovered, setHovered] = useState<number | null>(null);
  // Aiming is measured from where the menu actually is, so the clamped
  // centre has to be what both the layout and the flick use.
  const origin = clampMenuOrigin(
    x,
    y,
    window.innerWidth,
    window.innerHeight,
    RING_REACH
  );
  // A flick outranks the pointer resting somewhere: while one is in progress
  // it is what a release would take.
  const reading = aimed ?? hovered;
  const readItem = reading === null ? null : items[reading];

  useEffect(() => {
    /**
     * A press with the menu already open is a flick: track where it points,
     * and commit on release. Releases with no travel fall in the dead zone
     * and pick nothing, which is what leaves plain clicking a slot intact.
     */
    function onPointerMove(event: PointerEvent) {
      if (event.buttons === 0) {
        return;
      }
      setAimed(
        sectorForVector(
          event.clientX - origin.x,
          event.clientY - origin.y,
          items.length
        )
      );
    }
    function onPointerUp(event: PointerEvent) {
      const sector = sectorForVector(
        event.clientX - origin.x,
        event.clientY - origin.y,
        items.length
      );
      const item = sector === null ? null : items[sector];
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
      // The menu draws nothing between the slots, so that press lands on the
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
  }, [origin.x, origin.y, items, onSelect, onClose]);

  return (
    <div
      ref={ref}
      className="marking-menu"
      role="menu"
      aria-label="Selection actions"
      style={{ left: origin.x, top: origin.y }}
    >
      <span
        className={`marking-menu-hub${readItem ? ' armed' : ''}${
          readItem?.danger ? ' danger' : ''
        }`}
        style={{
          width: MARKING_DEAD_ZONE_PX * 2,
          height: MARKING_DEAD_ZONE_PX * 2
        }}
        aria-hidden="true"
      >
        {readItem ? (
          <>
            {/* The ellipsis promises a dialog, which the hub has no room to
                keep saying — the slot's own name still carries it. */}
            <span className="marking-menu-read">
              {readItem.label.replace(/…$/, '')}
            </span>
            <small>
              {readItem.disabled
                ? 'unavailable'
                : (readItem.shortcut ?? 'release')}
            </small>
          </>
        ) : (
          <span className="marking-menu-rest">Aim</span>
        )}
      </span>
      {items.map((item, index) => {
        const at = sectorPosition(index, items.length, RING_RADIUS);
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            // Icons alone leave nothing for a screen reader — or for a test —
            // to go on, so the name the hub shows is the name the slot has.
            aria-label={item.label}
            className={`marking-menu-slot${aimed === index ? ' aimed' : ''}${
              item.danger ? ' danger' : ''
            }`}
            disabled={item.disabled}
            style={{ left: at.x, top: at.y }}
            onPointerEnter={() => setHovered(index)}
            onPointerLeave={() =>
              setHovered((current) => (current === index ? null : current))
            }
            onFocus={() => setHovered(index)}
            onBlur={() =>
              setHovered((current) => (current === index ? null : current))
            }
            onClick={() => {
              onSelect(item.id);
              onClose();
            }}
          >
            <span className="marking-menu-icon" aria-hidden="true">
              {item.icon ?? item.label.slice(0, 1)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
