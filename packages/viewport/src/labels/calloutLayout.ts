/**
 * Screen-space placement for measurement callouts.
 *
 * A measurement pill centred on its 3D anchor sits exactly on top of the
 * geometry it describes — an area label covers the face it measures. This
 * layout moves every pill off the geometry instead: point-style callouts
 * slide out just past the projected box of what they describe — or, when
 * that is unknown, past the model's projected silhouette — on a short leash
 * (the caller draws a leader back to the anchor), span labels lift off their
 * dimension line the
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
  /**
   * Projected screen box of the one thing a point callout describes (the
   * face an area measures, say), CSS px. With it the pill stands just
   * outside that thing; without it, outside the whole model.
   */
  bounds?: CalloutBounds;
}

export interface CalloutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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
/** Clearance between a point callout's own target box and its pill. */
const BOUNDS_MARGIN = 10;
/**
 * Longest allowed anchor-to-pill distance. Zoomed far in, the silhouette
 * circle leaves the screen entirely; past this leash the label stays near
 * its anchor rather than pinned to a distant viewport edge.
 */
const MAX_LEASH = 220;
/**
 * Where a callout placed against its own target's box stands when even the
 * full leash would not clear that box. The pill sits on the face either
 * way, so the leader stays short rather than running the whole leash: an
 * area label that far out on a long leader stopped reading as belonging to
 * its face.
 */
const BOUNDED_LEASH = 120;
/** Pill edge padding kept inside the viewport. */
const EDGE_PAD = 8;
/** Minimum clear gap between two pills. */
const PILL_GAP = 6;
/** Anchor-to-edge distance below which a leader line is just noise. */
const MIN_LEADER = 12;

/** Square exits from a point callout's own box. */
const AXIS_DIRS: readonly CalloutPoint[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 }
];

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

/**
 * How far from `from`, along unit `dir`, the ray leaves `box`; zero when it
 * starts outside the box or on its edge.
 */
function exitDistance(
  from: CalloutPoint,
  dir: CalloutPoint,
  box: CalloutBounds
): number {
  const along = (start: number, step: number, min: number, max: number) =>
    step > 1e-9
      ? (max - start) / step
      : step < -1e-9
        ? (min - start) / step
        : Infinity;
  const exit = Math.min(
    along(from.x, dir.x, box.minX, box.maxX),
    along(from.y, dir.y, box.minY, box.maxY)
  );
  return Number.isFinite(exit) ? Math.max(0, exit) : 0;
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

  let target: CalloutPoint;
  if (item.bounds) {
    // A point callout that knows what it describes stands just outside
    // that — an area's label beside its face — still on the side away from
    // the model, rather than outside the whole model's silhouette.
    // It leaves by the shortest way out on that side: straight out from the
    // model, or square to whichever box edge faces away from it.
    const bounds = item.bounds;
    const ways = [outward, ...AXIS_DIRS].filter(
      (dir) => dir.x * outward.x + dir.y * outward.y > 1e-6
    );
    let best = { dir: outward, clear: Infinity };
    for (const dir of ways) {
      const clear =
        exitDistance(anchor, dir, bounds) +
        BOUNDS_MARGIN +
        boxExtent(item.width, item.height, dir);
      if (clear < best.clear - 1e-6) {
        best = { dir, clear };
      }
    }
    // A face the leash cannot clear (zoomed in, it fills the screen) keeps
    // the pill on a short leader instead: it sits on the face either way.
    const dir = best.clear > MAX_LEASH ? outward : best.dir;
    const reach = best.clear > MAX_LEASH ? BOUNDED_LEASH : best.clear;
    target = {
      x: anchor.x + dir.x * reach,
      y: anchor.y + dir.y * reach
    };
  } else {
    // Otherwise point callouts (areas, diameters, bodies, angles) ride the
    // silhouette ring: from the projected centre, past the projected radius,
    // plus enough of the pill's own box that its near edge clears the ring.
    const base = center ?? anchor;
    const ring =
      viewport.radius +
      RING_MARGIN +
      boxExtent(item.width, item.height, outward);
    target = {
      x: base.x + outward.x * ring,
      y: base.y + outward.y * ring
    };
  }
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
