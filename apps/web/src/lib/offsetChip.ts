import { formatNumber } from './model';
import {
  selectionCalloutObstacleShift,
  type ScreenRect
} from './selectionCalloutView';

/** Which number the offset chip shows: the drag delta, or the whole span. */
export type OffsetChipMode = 'offset' | 'total';

/** What a freshly armed offset-arrow rig's chip starts from. */
export interface OffsetChipState {
  mode: OffsetChipMode;
  /** The span to the plane opposing the armed face, for "Total". */
  extent: number | null;
  /** Whether the chip can switch to Total: a span is known to read. */
  totalAvailable: boolean;
}

/**
 * A face offset reads, and a typed number means, the signed distance the face
 * moves (+ out, − in) — the change the edit records. Total, the whole span
 * the face sets (a primitive's own dimension, or the distance to the flat
 * face opposing any other face), is one click away on the chip's tag when
 * there is a span to read. Starting on Total made a typed 5 on a 24 mm
 * body's top face move it −19 (QA 2026-11-14 finding #9).
 */
export function faceOffsetChipState(
  totalBaseline: number | undefined,
  extentBehind: number | null
): OffsetChipState {
  return {
    mode: 'offset',
    extent: extentBehind,
    totalAvailable: totalBaseline !== undefined || extentBehind !== null
  };
}

/**
 * The reading a re-armed face rig's chip shows. The workspace re-derives the
 * handle whenever the interaction changes — opening exact entry, a preview
 * landing, an edit on another body landing — so the same face re-arms many
 * times while it stays selected, and resetting each time undid the user's
 * Total/Offset switch under an open keypad. The face the switch was made on
 * (see `continuesOffsetFace`) reads what was chosen for it whenever it has a span
 * to read; any other face, or a moment without a span (the body's analysis
 * catching up), reads the default, Offset, without forgetting the choice.
 * The choice is never stored beyond that face: no setting, no session
 * storage.
 */
export function rearmedChipMode(
  fresh: OffsetChipState,
  chosen: OffsetChipMode,
  chosenHere: boolean
): OffsetChipMode {
  return chosenHere && fresh.totalAvailable ? chosen : fresh.mode;
}

/** The face a Total/Offset switch was made on, as `continuesOffsetFace` reads it. */
export interface OffsetFaceIdentity {
  bodyId: string;
  topologyId: string;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

/** An armed face handle: its identity, and the face a commit moved into it. */
export interface OffsetFaceHandle extends OffsetFaceIdentity {
  movedFrom?: string;
}

/**
 * Whether a re-armed face handle is the face the chip's switch was made on,
 * proven, never guessed: the same face id on the same plane (an id reused
 * for another face after the topology changed lies elsewhere), or the face
 * a committed offset moved it to, as the commit itself names it
 * (`movedFrom`). Facing the same way proves nothing — a shoulder and the cap
 * above it, or two coplanar faces of one part, are different faces — and
 * anything unproven reads the default, Offset.
 */
export function continuesOffsetFace(
  chosen: OffsetFaceIdentity,
  next: OffsetFaceHandle
): boolean {
  // Face normals are unit vectors; points are in document units.
  const n = chosen.normal;
  const m = next.normal;
  const p = chosen.point;
  const q = next.point;
  return (
    chosen.bodyId === next.bodyId &&
    n.x * m.x + n.y * m.y + n.z * m.z > 1 - 1e-6 &&
    // The moved face keeps naming the face it came from after the switch
    // has followed it, so its own id on its own plane still counts.
    (next.movedFrom === chosen.topologyId ||
      (next.topologyId === chosen.topologyId &&
        Math.abs(n.x * (q.x - p.x) + n.y * (q.y - p.y) + n.z * (q.z - p.z)) <
          1e-5))
  );
}

/**
 * A sketch-region extrude shares the face offset's arrow rig, but nothing
 * stands behind a region and it has no dimension of its own: it always reads
 * the signed distance. Arming it must reset the chip, or it inherits the last
 * face's Total mode and span (a −5 drag read "Total 5").
 */
export function regionChipState(): OffsetChipState {
  return { mode: 'offset', extent: null, totalAvailable: false };
}

/**
 * The span a Total chip reads for an offset, to the hundredth; null when the
 * chip reads the change instead (Offset mode, or no span to add to).
 */
export function offsetTotalReading(input: {
  rawValue: number;
  mode: OffsetChipMode;
  span: number | null | undefined;
  sense: number;
}): number | null {
  const { rawValue, mode, span, sense } = input;
  if (mode !== 'total' || span === null || span === undefined) return null;
  return Math.round((span + sense * rawValue) * 100) / 100;
}

/** The offset chip's value text, before any warning marker. */
export function offsetChipText(input: {
  rawValue: number;
  mode: OffsetChipMode;
  /** The span "Total" adds the offset to, when one is known. */
  span: number | null;
  /** +1 when the offset grows the span, −1 when it shrinks it. */
  sense: number;
  units: string;
}): string {
  const { rawValue, units } = input;
  // Both readings round to hundredths, so flipping the tag changes the number
  // it shows, never how precisely it shows it.
  const total = offsetTotalReading(input);
  if (total !== null) return `${formatNumber(total)} ${units}`;
  return `${signedHundredths(rawValue)} ${units}`;
}

function signedHundredths(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

/**
 * What a committed face offset reports. History records the change (the
 * edit's own parameter, "+10.25 mm"), which the chip reads by default; when
 * the chip was switched to the Total the face leaves ("15.65 mm"), released
 * from that reading, the message names both, so the two numbers are seen to
 * be one edit.
 */
export function offsetFaceCommitMessage(
  offset: number,
  units: string,
  total?: number | null
): string {
  const change = `Offset face by ${signedHundredths(offset)} ${units}`;
  return total === null || total === undefined
    ? `${change}.`
    : `${change} · Total ${formatNumber(total)} ${units}.`;
}

/**
 * The limit a refused offset named, in the reading the chip is in: how far
 * the face can move ("max 6.4 mm"), or the span it cannot pass ("min 17.6 mm"
 * when the offset shrinks the span, "max" when it grows it). Hundredths, like
 * the value beside it. The limit itself refuses, so "max" is the display
 * precision's last word, not a promise that 6.4 exactly builds.
 */
export function offsetLimitChipText(input: {
  /** Signed like the offset: where the refusal begins. */
  limit: number;
  mode: OffsetChipMode;
  span: number | null;
  sense: number;
  units: string;
}): string {
  const { limit, mode, span, sense, units } = input;
  if (mode === 'total' && span !== null) {
    const bound = Math.round((span + sense * limit) * 100) / 100;
    return `${sense * limit < 0 ? 'min' : 'max'} ${formatNumber(bound)} ${units}`;
  }
  return `max ${formatNumber(Math.round(Math.abs(limit) * 100) / 100)} ${units}`;
}

/**
 * The value a refusal's way out offers when the refusal named a limit: the
 * nearest hundredth at least one hundredth inside it, on the limit's side of
 * zero. Null when no such value is left. Not proven to build — the commit
 * validates it like any other value — but past the boundary the kernel named.
 */
export function valueInsideLimit(limit: number): number | null {
  if (!Number.isFinite(limit)) return null;
  const magnitude = Math.floor((Math.abs(limit) - 0.01) * 100 + 1e-6) / 100;
  return magnitude > 0 ? Math.sign(limit) * magnitude : null;
}

/**
 * What a refused face offset's "Keep" commits: the value just inside the
 * limit the refusal named, unless the last frame that built already went at
 * least that far on the same side — that one is proven. Without a limit, the
 * last frame that built, as before.
 */
export function keptOffsetValue(
  limit: number | undefined,
  lastValid: number | null
): number | null {
  const inside = limit === undefined ? null : valueInsideLimit(limit);
  if (inside === null) return lastValid;
  if (
    lastValid !== null &&
    Math.sign(lastValid) === Math.sign(inside) &&
    Math.abs(lastValid) >= Math.abs(inside)
  ) {
    return lastValid;
  }
  return inside;
}

/** The gap kept between an edge chip and the right lane or the stage edge. */
const EDGE_CHIP_MARGIN_PX = 8;

/**
 * Where an edge rig's value chip centres horizontally: clear of the right
 * lane when the space left of it can hold the chip. At a phone width the lane
 * spans the stage from its left inset, and dodging it would put the chip,
 * and with it exact entry, off-screen; it stays on its anchor instead.
 */
export function edgeChipCenterX(
  anchorX: number,
  laneLeft: number | null,
  chipWidth: number
): number {
  if (laneLeft === null) return anchorX;
  const dodged = laneLeft - EDGE_CHIP_MARGIN_PX - chipWidth / 2;
  return dodged - chipWidth / 2 >= EDGE_CHIP_MARGIN_PX
    ? Math.min(anchorX, dodged)
    : anchorX;
}

/**
 * How far a handle's chip — its value pill and any tag beside it, as one
 * box, in the same coordinates as `stage` — moves to come out from under a
 * model panel the right lane's rule does not cover: a floating window or
 * the left dock. The right lane keeps its own rule (`edgeChipCenterX`, the
 * pin's swap to its other side), so while the stage has room left of the
 * lane no move here takes the chip into it. Nor does one take it above
 * `topbarBottom`: the top bar stands over the stage's top. A chip nothing
 * covers, or one no move inside the stage clears, stays where it is.
 */
export function chipPanelDodge(
  chip: ScreenRect,
  panels: readonly ScreenRect[],
  stage: ScreenRect,
  laneLeft: number | null,
  topbarBottom: number | null = null
): { dx: number; dy: number } {
  if (panels.length === 0) return { dx: 0, dy: 0 };
  const top =
    topbarBottom === null ? stage.top : Math.max(stage.top, topbarBottom);
  const width = chip.right - chip.left;
  const laneEdge =
    laneLeft !== null &&
    laneLeft - EDGE_CHIP_MARGIN_PX - width >= stage.left + EDGE_CHIP_MARGIN_PX
      ? Math.min(stage.right, laneLeft - EDGE_CHIP_MARGIN_PX)
      : stage.right;
  return selectionCalloutObstacleShift(
    chip,
    panels,
    // A chip the lane rule left over the lane (a phone's) may stay there.
    { ...stage, top, right: Math.max(laneEdge, chip.right) },
    EDGE_CHIP_MARGIN_PX
  );
}
