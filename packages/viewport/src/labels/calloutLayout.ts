/**
 * Screen-space placement for measurement callouts.
 *
 * A measurement pill centred on its 3D anchor sits exactly on top of the
 * geometry it describes — an area label covers the face it measures. This
 * layout moves every pill off the model instead: point-style callouts slide
 * radially out past the model's projected silhouette (the caller draws a
 * leader back to the anchor), span labels lift off their dimension line the
 * way drawing text sits beside a dimension, and a relaxation pass separates
 * pills that would overlap each other. Everything stays clamped inside the
 * viewport so a pushed label can never leave the screen.
 *
 * Pure screen-space math with no three.js types, so it unit-tests without a
 * renderer.
 */

export interface CalloutPoint {
  x: number;
  y: number;
}

export type CalloutKind = 'anchor' | 'span' | 'arms';

export interface CalloutLayoutItem {
  /** Projected anchor position, CSS px. */
  anchor: CalloutPoint;
  /** Rendered pill size, CSS px. */
  width: number;
  height: number;
  kind: CalloutKind;
  /** Projected span direction for 'span' items; need not be normalized. */
  spanDir?: CalloutPoint;
}

export interface CalloutLayoutViewport {
  width: number;
  height: number;
  /** Projected model centre, CSS px. Absent when nothing is on screen. */
  center: CalloutPoint | null;
  /** Projected model bounding radius, CSS px. */
  radius: number;
}

export interface CalloutPlacement {
  /** Pill centre target, CSS px. */
  x: number;
  y: number;
  /** True when the pill sits far enough off its anchor to earn a leader. */
  leader: boolean;
}

/** Ring clearance between the silhouette circle and a pushed-out pill. */
const RING_MARGIN = 22;
/** Gap between a span pill and its dimension line. */
const SPAN_LIFT = 11;
/**
 * Longest allowed anchor-to-pill distance. Zoomed far in, the silhouette
 * circle leaves the screen entirely; past this leash the label stays near
 * its anchor rather than pinned to a distant viewport edge.
 */
const MAX_LEASH = 220;
/** Pill edge padding kept inside the viewport. */
const EDGE_PAD = 8;
/** Minimum clear gap between two pills. */
const PILL_GAP = 6;
/** Anchor-to-edge distance below which a leader line is just noise. */
const MIN_LEADER = 12;

/** Direction used when an anchor projects onto the model centre exactly. */
const FALLBACK_DIR: CalloutPoint = { x: 0.8, y: -0.6 };

function normalize(x: number, y: number): CalloutPoint | null {
  const length = Math.hypot(x, y);
  if (length < 1e-6) {
    return null;
  }
  return { x: x / length, y: y / length };
}

/** Half-extent of a w×h box along a unit direction. */
function boxExtent(width: number, height: number, dir: CalloutPoint): number {
  return (Math.abs(dir.x) * width + Math.abs(dir.y) * height) / 2;
}

function initialTarget(
  item: CalloutLayoutItem,
  viewport: CalloutLayoutViewport
): CalloutPoint {
  const { anchor } = item;
  const center = viewport.center;
  const outward =
    (center && normalize(anchor.x - center.x, anchor.y - center.y)) ??
    FALLBACK_DIR;

  if (item.kind === 'span') {
    // Drawing convention: the value sits beside the dimension line, on the
    // side facing away from the model, not on the line itself.
    const along = item.spanDir && normalize(item.spanDir.x, item.spanDir.y);
    let perp = along ? { x: -along.y, y: along.x } : outward;
    if (perp.x * outward.x + perp.y * outward.y < 0) {
      perp = { x: -perp.x, y: -perp.y };
    }
    const lift = item.height / 2 + SPAN_LIFT;
    return { x: anchor.x + perp.x * lift, y: anchor.y + perp.y * lift };
  }

  // Point callouts (areas, diameters, bodies, angles) ride the silhouette
  // ring: from the projected centre, past the projected radius, plus enough
  // of the pill's own box that its near edge clears the ring.
  const base = center ?? anchor;
  const ring =
    viewport.radius + RING_MARGIN + boxExtent(item.width, item.height, outward);
  let target = {
    x: base.x + outward.x * ring,
    y: base.y + outward.y * ring
  };
  const leashX = target.x - anchor.x;
  const leashY = target.y - anchor.y;
  const leash = Math.hypot(leashX, leashY);
  if (leash > MAX_LEASH) {
    target = {
      x: anchor.x + (leashX / leash) * MAX_LEASH,
      y: anchor.y + (leashY / leash) * MAX_LEASH
    };
  } else if (leash < 1e-6) {
    // Anchor already sits on the ring; still stand the pill off the point.
    const lift = item.height / 2 + SPAN_LIFT;
    target = {
      x: anchor.x + outward.x * lift,
      y: anchor.y + outward.y * lift
    };
  }
  return target;
}

function clampInto(
  target: CalloutPoint,
  item: CalloutLayoutItem,
  viewport: CalloutLayoutViewport
): CalloutPoint {
  const halfW = item.width / 2;
  const halfH = item.height / 2;
  const minX = EDGE_PAD + halfW;
  const maxX = viewport.width - EDGE_PAD - halfW;
  const minY = EDGE_PAD + halfH;
  const maxY = viewport.height - EDGE_PAD - halfH;
  return {
    // A viewport narrower than the pill degenerates; prefer the near edge.
    x: Math.max(minX, Math.min(maxX, target.x)),
    y: Math.max(minY, Math.min(maxY, target.y))
  };
}

interface CalloutEntry {
  item: CalloutLayoutItem;
  target: CalloutPoint;
}

/**
 * Pushes overlapping pills apart, half the overlap each, along whichever
 * axis needs the smaller correction. A handful of passes settles the small
 * populations measurements produce; this is deliberately not a solver.
 */
function separate(entries: CalloutEntry[], viewport: CalloutLayoutViewport) {
  const passes = 6;
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    for (let a = 0; a < entries.length; a += 1) {
      for (let b = a + 1; b < entries.length; b += 1) {
        const first = entries[a]!;
        const second = entries[b]!;
        const needX = (first.item.width + second.item.width) / 2 + PILL_GAP;
        const needY = (first.item.height + second.item.height) / 2 + PILL_GAP;
        const dx = second.target.x - first.target.x;
        const dy = second.target.y - first.target.y;
        const overlapX = needX - Math.abs(dx);
        const overlapY = needY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }
        moved = true;
        if (overlapY <= overlapX) {
          const sign = dy === 0 ? (a % 2 === 0 ? -1 : 1) : Math.sign(dy);
          first.target.y -= (sign * overlapY) / 2;
          second.target.y += (sign * overlapY) / 2;
        } else {
          const sign = dx === 0 ? (a % 2 === 0 ? -1 : 1) : Math.sign(dx);
          first.target.x -= (sign * overlapX) / 2;
          second.target.x += (sign * overlapX) / 2;
        }
      }
    }
    for (const entry of entries) {
      entry.target = clampInto(entry.target, entry.item, viewport);
    }
    if (!moved) {
      break;
    }
  }
}

export function layoutMeasurementCallouts(
  items: readonly CalloutLayoutItem[],
  viewport: CalloutLayoutViewport
): CalloutPlacement[] {
  const entries: CalloutEntry[] = items.map((item) => ({
    item,
    target: clampInto(initialTarget(item, viewport), item, viewport)
  }));
  separate(entries, viewport);
  return entries.map(({ item, target }) => {
    const gap =
      Math.hypot(target.x - item.anchor.x, target.y - item.anchor.y) -
      boxExtent(
        item.width,
        item.height,
        normalize(item.anchor.x - target.x, item.anchor.y - target.y) ??
          FALLBACK_DIR
      );
    return { x: target.x, y: target.y, leader: gap >= MIN_LEADER };
  });
}
