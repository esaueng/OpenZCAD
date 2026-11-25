import { formatNumber } from './model';
import { roundShownLength } from './liveLabels';
import { storedHundredthDecimals } from './displayUnits';
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

/** The tag beside a face offset's value: which number it reads. */
export interface OffsetChipTag {
  text: string;
  /** Whether a click switches Total/Offset; otherwise it opens exact entry. */
  switchable: boolean;
  /** What a typed number means, on hover. */
  title: string;
}

/**
 * The tag a face offset's value carries. Every face names its mode, so the
 * same drag reads the same on every face of a body: a face with no flat face
 * opposite it had no tag at all, and its bare "+0 mm" left a typed number's
 * meaning unsaid beside a neighbour reading "Offset ▾ | +0 mm". Only a face
 * with a span to read is a Total/Offset switch, marked by its caret.
 */
export function offsetChipTag(
  mode: OffsetChipMode,
  spanKnown: boolean
): OffsetChipTag {
  if (!spanKnown) {
    return {
      text: 'Offset',
      switchable: false,
      title:
        'Offset: a typed value is how far the face moves · No flat face lies opposite this one, so there is no Total to read'
    };
  }
  return mode === 'total'
    ? {
        text: 'Total ▾',
        switchable: true,
        title:
          'Total: a typed value is the size this face sets · Switch to Offset to type how far it moves'
      }
    : {
        text: 'Offset ▾',
        switchable: true,
        title:
          'Offset: a typed value is how far the face moves · Switch to Total to type the size it sets'
      };
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
  /** I03: a reading converted into another unit; see {@link reading}. */
  precise?: boolean;
}): number | null {
  const { rawValue, mode, span, sense, precise } = input;
  if (mode !== 'total' || span === null || span === undefined) return null;
  return reading(span + sense * rawValue, precise);
}

/**
 * Hundredths, as every offset reading has always been. A reading converted
 * into a display unit (I03) keeps three significant figures below one
 * instead, so −2 mm shown in metres reads −0.002 m, not +0 m.
 */
function reading(value: number, precise = false): number {
  return precise ? roundShownLength(value) : Math.round(value * 100) / 100;
}

/** A reading as text: `formatNumber`'s thousandths would undo `precise`. */
function shownNumber(value: number, precise = false): string {
  return precise ? String(value) : formatNumber(value);
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
  precise?: boolean;
}): string {
  const { rawValue, units, precise } = input;
  // Both readings round to hundredths, so flipping the tag changes the number
  // it shows, never how precisely it shows it.
  const total = offsetTotalReading(input);
  if (total !== null) return `${shownNumber(total, precise)} ${units}`;
  return `${signedHundredths(rawValue, precise)} ${units}`;
}

function signedHundredths(value: number, precise = false): string {
  const rounded = reading(value, precise);
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
  total?: number | null,
  /** I03: the numbers were converted into a display unit. */
  precise = false
): string {
  const change = `Offset face by ${signedHundredths(offset, precise)} ${units}`;
  return total === null || total === undefined
    ? `${change}.`
    : `${change} · Total ${shownNumber(total, precise)} ${units}.`;
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
  precise?: boolean;
  /**
   * I03: the stored-to-shown factor the limit and span were converted by.
   * A converted limit then keeps the decimals that resolve a hundredth of
   * the stored unit (`storedHundredthDecimals`), as the keypad's refusal
   * and Keep say it (`formatDocumentHundredths`): three significant figures
   * read "min 0.693 in" beside the keypad's "minimum 0.6929 in".
   */
  scale?: number;
}): string {
  const { limit, mode, span, sense, units, precise, scale } = input;
  const decimals =
    scale !== undefined && scale !== 1 ? storedHundredthDecimals(scale) : null;
  const shown = (value: number) => {
    if (decimals === null) return shownNumber(reading(value, precise), precise);
    const number = Number(value.toFixed(decimals));
    return String(Object.is(number, -0) ? 0 : number);
  };
  if (mode === 'total' && span !== null) {
    const bound = span + sense * limit;
    return `${sense * limit < 0 ? 'min' : 'max'} ${shown(bound)} ${units}`;
  }
  return `max ${shown(Math.abs(limit))} ${units}`;
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
 *
 * Never the value that was just refused: the live preview and the release
 * check build differently, so the last frame that built can be the very
 * value release validation refused, and "Keep" would offer a value that
 * cannot be built (#1596). Null then — there is nothing to keep.
 */
export function keptOffsetValue(
  limit: number | undefined,
  lastValid: number | null,
  refused: number | null = null
): number | null {
  // The refused value is no candidate at all, so a limit the refusal named
  // still offers its way out when the last built frame was that value.
  const built =
    lastValid !== null &&
    refused !== null &&
    sameOffsetValue(lastValid, refused)
      ? null
      : lastValid;
  const kept = keptOffsetCandidate(limit, built);
  return kept !== null && refused !== null && sameOffsetValue(kept, refused)
    ? null
    : kept;
}

function keptOffsetCandidate(
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

function sameOffsetValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** The gap kept between an edge chip and the right lane or the stage edge. */
export const EDGE_CHIP_MARGIN_PX = 8;

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
 * Whether the stage left of the right lane can hold `width` px of chip with
 * a margin either side. At a phone width the lane (the Objects or a tool
 * panel) spans the stage from its left inset: a lane rule there would push
 * the chip, and exact entry with it, off the stage's left edge.
 */
export function laneLeavesRoom(
  laneLeft: number | null,
  width: number
): boolean {
  return (
    laneLeft !== null &&
    laneLeft - EDGE_CHIP_MARGIN_PX - width >= EDGE_CHIP_MARGIN_PX
  );
}

/**
 * Where a pin's chip pair (the Offset/Total or Fillet/Chamfer tag, then the
 * value; `width` px as one box, in canvas coordinates) starts. It reads
 * beside the pin on the side `anchorX` is on, `clearance` px clear of the
 * pin; one that would reach the right lane goes to the pin's other side.
 * The lane counts only while it leaves room for the pair
 * (`laneLeavesRoom`), and the pair never starts off the stage's left edge or
 * ends past its right: a phone's offset tag and value were placed off the
 * left edge with the Objects panel open.
 */
export function pinChipPairStart(input: {
  anchorX: number;
  pinX: number;
  width: number;
  clearance: number;
  laneLeft: number | null;
  stageWidth: number;
}): number {
  const { anchorX, pinX, width, clearance, laneLeft, stageWidth } = input;
  const limit = Math.min(
    stageWidth - EDGE_CHIP_MARGIN_PX,
    laneLeavesRoom(laneLeft, width) && laneLeft !== null
      ? laneLeft - EDGE_CHIP_MARGIN_PX
      : Number.POSITIVE_INFINITY
  );
  let start =
    anchorX >= pinX ? anchorX - clearance : anchorX + clearance - width;
  if (start + width > limit) {
    // The pin's other side, when the pair fits there; otherwise as far
    // right as the limit allows, over the pin rather than off the stage
    // (or under the tool column at its left edge).
    const flipped = pinX - clearance - width;
    start =
      flipped >= EDGE_CHIP_MARGIN_PX
        ? Math.min(flipped, limit - width)
        : limit - width;
  }
  return Math.max(EDGE_CHIP_MARGIN_PX, Math.min(start, limit - width));
}

/**
 * How far a handle's chip — its value pill and any tag beside it, as one
 * box, in the same coordinates as `stage` — moves to come out from under a
 * model panel the right lane's rule does not cover: a floating window or
 * the left dock. The right lane keeps its own rule (`edgeChipCenterX`, the
 * pin's swap to its other side), so while the stage has room left of the
 * lane no move here takes the chip into it. Nor does one take it above
 * `topbarBottom`: the top bar stands over the stage's top, or below
 * `footBottom`, where the chip would be clamped back over what it dodged. A
 * chip nothing covers, or one no move inside the stage clears, stays where
 * it is.
 */
export function chipPanelDodge(
  chip: ScreenRect,
  panels: readonly ScreenRect[],
  stage: ScreenRect,
  laneLeft: number | null,
  topbarBottom: number | null = null,
  /** The lowest a pill's foot may stand (above a command's bar), if any. */
  footBottom: number | null = null
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
    // Each side by name: the stage is the canvas's DOMRect, whose sides are
    // getters a spread does not copy. Spread, the bounds had no left or
    // bottom, and a phone's offset pair dodged the Objects panel off the
    // stage's left edge.
    {
      left: stage.left,
      top,
      // A chip the lane rule left over the lane (a phone's) may stay there.
      right: Math.max(laneEdge, chip.right),
      bottom:
        footBottom === null ? stage.bottom : Math.min(stage.bottom, footBottom)
    },
    EDGE_CHIP_MARGIN_PX
  );
}

/**
 * The offset-limit sentence ("… past -6.4. Try a smaller offset.") as the
 * adapter writes it: the limit signed like the offset, in document units but
 * without a unit, because the adapter does not know the unit the document is
 * shown in.
 */
const OFFSET_LIMIT_SENTENCE =
  / past ([−-]?\d+(?:\.\d+)?(?:e-?\d+)?)(\. Try a smaller offset\.)/;

/**
 * A refused face offset's limit sentence with the document's unit, signed
 * like the offset and like the "Keep −6.39 mm" beside it: "… shrink to
 * nothing past -6.4 mm. Try a smaller offset." The typed limit, when the
 * refusal carries one, wins over the sentence's rounded (and, from an older
 * adapter, unsigned) number; `formatLength` writes a stored-unit length in
 * the display unit with its suffix (`formatDocumentLength`), rounding in
 * that unit.
 */
export function offsetLimitInUnits<
  T extends { message: string; limit?: number }
>(error: T, formatLength: (value: number) => string): T {
  const match = OFFSET_LIMIT_SENTENCE.exec(error.message);
  if (!match) return error;
  const stated = Number(match[1]!.replace('−', '-'));
  const limit =
    error.limit !== undefined &&
    Number.isFinite(error.limit) &&
    error.limit !== 0
      ? error.limit
      : stated;
  if (!Number.isFinite(limit)) return error;
  // Unrounded: `formatLength` rounds once, in the unit it shows. Rounding
  // here first, in the stored unit, moved an inch limit off its millimetre
  // value (-0.2519685 in read -6.35 mm) and a small one to an unsigned 0.
  return {
    ...error,
    message: error.message.replace(
      OFFSET_LIMIT_SENTENCE,
      ` past ${formatLength(limit)}$2`
    )
  };
}

/** A refused face offset's line, as the control that refused it says it. */
export interface OffsetRefusalReading {
  /** The refusal: its message, and the limit the kernel named, if any. */
  error: { message: string; headline?: string; limit?: number };
  /** The way out's label ("Keep −18.99 mm"), when there is one. */
  keepLabel: string | null;
}

/**
 * U11: a refused face offset said in the Total reading, while exact entry
 * takes a Total. The kernel and the way out speak in the offset the edit
 * records ("shrink to nothing past -19 mm · Try a smaller offset", "Keep
 * −18.99 mm"), which beside a Total of 5 reads as a second, unrelated
 * number: a smaller offset is a larger Total when the face moves in. The
 * limit is restated as the Total it leaves (as the chip's "min 5.01 mm"
 * is), the remedy as the way the Total must go, and Keep names the Total it
 * keeps. The offset stays in the cause, since that is what History records.
 */
export function offsetRefusalInTotal<T extends OffsetRefusalReading['error']>(
  error: T,
  keep: number | null,
  reading: {
    /** The span before this edit: the keypad's `totalBaseline`. */
    baseline: number;
    sense: number;
    /**
     * A stored-unit length in the document's display unit with its suffix
     * (`formatDocumentLength`), so a document shown in inches reads its
     * Totals in inches.
     */
    formatLength: (value: number) => string;
  }
): { error: T & { headline?: string }; keepLabel: string | null } {
  const { baseline, sense, formatLength } = reading;
  const total = (offset: number) => formatLength(baseline + sense * offset);
  const keepLabel = keep === null ? null : `Keep Total ${total(keep)}`;
  const limit = error.limit;
  if (limit === undefined || !Number.isFinite(limit) || limit === 0) {
    return {
      error: {
        ...error,
        message: error.message.replace(
          /Try a smaller offset\./,
          `Try a Total nearer ${total(0)}.`
        )
      },
      keepLabel
    };
  }
  const shrinks = sense * limit < 0;
  const bound = total(limit);
  const move = formatLength(Math.abs(limit));
  return {
    error: {
      ...error,
      headline: `Total can’t go ${shrinks ? 'below' : 'past'} ${bound} here`,
      message: error.message.replace(
        // Bare (the adapter's) or with its unit (`offsetLimitInUnits`).
        /past [−-]?[\d.]+(?:e-?\d+)?(?: [a-z]+)?\. Try a smaller offset\./,
        `once the face moves ${move} (a Total of ${bound}). Try a ${
          shrinks ? 'larger' : 'smaller'
        } Total.`
      )
    },
    keepLabel
  };
}
