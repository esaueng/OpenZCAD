import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import type { ContextMenuItem } from './ContextMenu';
import {
  clampMenuOrigin,
  sectorForVector,
  sectorPosition,
  slotPositionClearOfHub
} from '../lib/markingMenu';

/** How far from the centre the slots sit. */
const RING_RADIUS = 96;
/** Half a slot plus breathing room; added to every clearance the ring keeps. */
const SLOT_CLEARANCE = 27;

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
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [aimed, setAimed] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // Half the widest pill this menu can show, plus half its height. The ring
  // is laid out against the widest label rather than the hovered one, so the
  // slots never move while the hand is mid-gesture.
  const [pillHalf, setPillHalf] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const host = measureRef.current;
    if (!host) {
      return;
    }
    let width = 0;
    let height = 0;
    for (const child of host.children) {
      const rect = child.getBoundingClientRect();
      width = Math.max(width, rect.width);
      height = Math.max(height, rect.height);
    }
    setPillHalf({ width: width / 2, height: height / 2 });
  }, [items]);

  // Slots never share the pill's horizontal band (they settle above or
  // below it), but the pill itself still widens with its longest label, so
  // the screen-edge clamp and the dismiss radius follow whichever is wider.
  const clearWidth = pillHalf.width + SLOT_CLEARANCE;
  const clearHeight = pillHalf.height + SLOT_CLEARANCE;
  const reach = Math.max(RING_RADIUS, clearWidth) + 48;
  // Aiming is measured from where the menu actually is, so the clamped
  // centre has to be what both the layout and the flick use.
  const origin = clampMenuOrigin(
    x,
    y,
    window.innerWidth,
    window.innerHeight,
    reach
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
      const travel = Math.hypot(
        event.clientX - origin.x,
        event.clientY - origin.y
      );
      if (travel > reach) {
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
  }, [origin.x, origin.y, items, onSelect, onClose, reach]);

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
        aria-hidden="true"
      >
        {readItem ? (
          <>
            {/* The aimed slot's own icon rides along, so the readout
                confirms which button the flick is on without the eye
                leaving the centre. */}
            <span className="marking-menu-hub-icon">
              {readItem.icon ?? readItem.label.slice(0, 1)}
            </span>
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
      {/* One hidden pill per item, rendered with the hub's own classes so
          the measurement is the truth rather than an estimate. */}
      <div ref={measureRef} className="marking-menu-measure" aria-hidden="true">
        {items.map((item) => (
          <span key={item.id} className="marking-menu-hub">
            <span className="marking-menu-hub-icon">
              {item.icon ?? item.label.slice(0, 1)}
            </span>
            <span className="marking-menu-read">
              {item.label.replace(/…$/, '')}
            </span>
            <small>
              {item.disabled ? 'unavailable' : (item.shortcut ?? 'release')}
            </small>
          </span>
        ))}
      </div>
      {items.map((item, index) => {
        const at = slotPositionClearOfHub(
          sectorPosition(index, items.length, RING_RADIUS),
          clearHeight
        );
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
