import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import type { ContextMenuItem } from './ContextMenu';
import { useMenuKeyboard } from '../lib/useMenuKeyboard';
import {
  clampMenuOrigin,
  MARKING_DEAD_ZONE_PX,
  sectorAnchor,
  sectorForVector,
  type MenuExtents
} from '../lib/markingMenu';

/** How far from the centre the pills are anchored (before the ring's aspect). */
const RING_RADIUS = 96;
/** Breathing room kept between the ring and the screen edge. */
const EDGE_MARGIN = 12;
/** Height of a pill before it has been measured, for the first frame. */
const PILL_FALLBACK = { width: 120, height: 28 };

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
 * never has to reach the pill. Clicking a pill works too, and both paths read
 * the same ring, so the fast way is the slow way done confidently rather than
 * something separate to learn.
 *
 * Each action is a labelled pill, name and shortcut on it, hung around a
 * dot at the click point. The pill a release would take is the one lit, so
 * an overshoot is caught before the button comes up; nothing else is drawn,
 * because the model underneath is what the menu is about.
 */
export function MarkingMenu({
  x,
  y,
  items,
  onSelect,
  onClose
}: MarkingMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [aimed, setAimed] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [extents, setExtents] = useState<MenuExtents>(() =>
    ringExtents(items.length, () => PILL_FALLBACK)
  );
  useMenuKeyboard(ref);

  // The pills hang outward from their anchors, so how far the ring reaches
  // depends on the labels. Measured from layout rather than from the drawn
  // boxes: the opening animation scales the whole ring for its first frame.
  useLayoutEffect(() => {
    setExtents(
      ringExtents(items.length, (index) => {
        const slot = slotRefs.current[index];
        return slot && slot.offsetWidth > 0
          ? { width: slot.offsetWidth, height: slot.offsetHeight }
          : PILL_FALLBACK;
      })
    );
  }, [items]);

  // Aiming is measured from where the menu actually is, so the clamped
  // centre has to be what both the layout and the flick use.
  const origin = clampMenuOrigin(
    x,
    y,
    window.innerWidth,
    window.innerHeight,
    extents
  );
  // A flick outranks the pointer resting somewhere: while one is in progress
  // it is what a release would take.
  const reading = aimed ?? hovered;

  useEffect(() => {
    /**
     * A press with the menu already open is a flick: track where it points,
     * and commit on release. Releases with no travel fall in the dead zone
     * and pick nothing, which is what leaves plain clicking a pill intact.
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
      // The field catches every press inside the ring's box, so a press that
      // reaches here is outside it: elsewhere on the page, not a flick.
      onClose();
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

  const readItem = reading === null ? null : items[reading];

  return (
    <div
      ref={ref}
      className="marking-menu"
      role="menu"
      aria-label="Selection actions"
      tabIndex={-1}
      style={{ left: origin.x, top: origin.y }}
    >
      {/* Everything inside the ring's box is the menu's: a press there is a
          flick starting, and the model behind must not see it, or a flick
          from the centre would drag whatever face it happened to open over. */}
      <div
        className="marking-menu-field"
        aria-hidden="true"
        style={{
          left: -extents.left,
          top: -extents.top,
          width: extents.left + extents.right,
          height: extents.top + extents.bottom
        }}
      />
      {/* The click point itself. Releasing within the dead zone around it
          picks nothing, which is what keeps a plain click on a pill intact. */}
      <span
        className={`marking-menu-origin${readItem ? ' armed' : ''}${
          readItem?.danger ? ' danger' : ''
        }`}
        aria-hidden="true"
      />
      {items.map((item, index) => {
        const anchor = sectorAnchor(index, items.length, RING_RADIUS);
        return (
          <button
            key={item.id}
            ref={(element) => {
              slotRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            // The shortcut rides on the pill, so the accessible name stays
            // the action alone.
            aria-label={item.label}
            className={`marking-menu-slot ${anchor.align}${
              reading === index ? ' aimed' : ''
            }${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            style={{ left: anchor.x, top: anchor.y }}
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
            {/* The ellipsis promises a dialog; the pill has no room to keep
                saying so and the accessible name still carries it. */}
            <span className="marking-menu-label" aria-hidden="true">
              {item.label.replace(/…$/, '')}
            </span>
            {item.shortcut && !item.disabled ? (
              <kbd className="marking-menu-key" aria-hidden="true">
                {item.shortcut}
              </kbd>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * How far the ring reaches from its centre on each side, from the anchors
 * and each pill's size. Pills hang outward from their anchors, so the
 * extent on a side is the farthest pill edge on that side.
 */
function ringExtents(
  count: number,
  sizeOf: (index: number) => { width: number; height: number }
): MenuExtents {
  let left = MARKING_DEAD_ZONE_PX;
  let right = MARKING_DEAD_ZONE_PX;
  let top = MARKING_DEAD_ZONE_PX;
  let bottom = MARKING_DEAD_ZONE_PX;
  for (let index = 0; index < count; index += 1) {
    const anchor = sectorAnchor(index, count, RING_RADIUS);
    const { width, height } = sizeOf(index);
    const pillLeft =
      anchor.align === 'center'
        ? anchor.x - width / 2
        : anchor.align === 'start'
          ? anchor.x
          : anchor.x - width;
    left = Math.max(left, -pillLeft);
    right = Math.max(right, pillLeft + width);
    top = Math.max(top, -(anchor.y - height / 2));
    bottom = Math.max(bottom, anchor.y + height / 2);
  }
  return {
    left: left + EDGE_MARGIN,
    right: right + EDGE_MARGIN,
    top: top + EDGE_MARGIN,
    bottom: bottom + EDGE_MARGIN
  };
}
