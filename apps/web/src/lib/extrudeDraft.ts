import type { MutableRefObject } from 'react';
import {
  EXTRUDE_SIDES_CONFLICT_MESSAGE,
  MAX_EXTRUDE_DRAFT_DEG,
  coerceParamValue,
  extrudeSidesConflict,
  toFaceExtent
} from '@openzcad/document-core';
import type {
  BodyId,
  ExtrudeEndCondition,
  ExtrudeToFaceTarget,
  ParamValue,
  SketchId,
  ThroughAllSide,
  UnitSystem
} from '@openzcad/shared';
import type { ExtrudeChoice } from './extrudeInference';
import { paramValueText, previewExpression } from './model';

/**
 * An extrude's settings while they are being edited, and the rules that turn
 * them into what Create or Apply stores. Shared by the History editor's card
 * and the in-place Extrude's bar (U09), so the two refuse the same
 * combinations by the same words.
 */

export interface ExtrudeFormValue {
  name: string;
  sketchId: SketchId;
  distance: ParamValue;
  symmetric: boolean;
  /**
   * Absent exactly when `symmetric`: a symmetric extrude has no back
   * distance, and the document refuses one beside it.
   */
  backDistance?: ParamValue;
  choice: ExtrudeChoice;
  /**
   * F01: `through-all` is offered for an explicit cut only. Absent reads as
   * blind.
   */
  endCondition?: ExtrudeEndCondition;
  throughAllSide?: ThroughAllSide;
  /** F01 (v29): present exactly with `to-face`. */
  toFace?: ExtrudeToFaceTarget;
  /**
   * F01 (v113): with `to-face` only, and absent when it ends on the face
   * (a typed 0 is sent as absent). Positive stops short, negative passes.
   */
  toFaceOffset?: ParamValue;
  /**
   * F01 (v121): where the extrusion starts along the sketch normal; absent
   * through all and when it starts on the sketch plane (a typed 0).
   */
  startOffset?: ParamValue;
  /** F01 (v29): absent for straight walls (a typed 0 is sent as absent). */
  draftAngleDeg?: ParamValue;
  /**
   * F01 (v126): the back side's draft; sent only for a blind extrude that
   * has a back side (symmetric or a back distance), and absent at zero.
   */
  backDraftAngleDeg?: ParamValue;
}

/**
 * What the host tells the editor about a to-face target: how it reads, and
 * where the build will put it (the signed distance from the sketch plane),
 * or why it cannot reach it from this sketch.
 */
export interface ExtrudeToFaceInfo {
  label: string;
  distance: number | null;
  pending?: boolean;
  problem?: string;
}

/** The host's side of the to-face pick. */
export interface ExtrudeToFacePicking {
  /** True while the viewport is waiting for this editor's face. */
  armed: boolean;
  /** Arms (or, when armed, cancels) the viewport face pick. */
  onPick(): void;
  /**
   * Withdraws this editor's armed pick, if any: called when it closes, so a
   * closed editor never leaves the viewport waiting for its face.
   */
  cancel(): void;
  /** How a target reads and where it sits, from the current projection. */
  describe(target: ExtrudeToFaceTarget): ExtrudeToFaceInfo;
  /** The stored face no longer resolves (edit only). */
  unresolved?: boolean;
  /** Receives the face the viewport pick produced. */
  setterRef: MutableRefObject<((target: ExtrudeToFaceTarget) => void) | null>;
}

/** The settings as typed: every number is its field's text. */
export interface ExtrudeDraft {
  name: string;
  distance: string;
  symmetric: boolean;
  backDistance: string;
  choice: ExtrudeChoice;
  endCondition: ExtrudeEndCondition;
  throughAllSide: ThroughAllSide;
  toFace?: ExtrudeToFaceTarget;
  /** F01 (v113): the offset from the face, as typed; read with To face. */
  faceOffset: string;
  /** F01 (v121): the start offset, as typed; read except through all. */
  startOffset: string;
  draftAngle: string;
  /** F01 (v126): the back side's draft, as typed. */
  backDraftAngle: string;
}

/** What an extrude editor opens with. */
export interface ExtrudeDraftInitial {
  name: string;
  sketchId: SketchId;
  distance: ParamValue;
  symmetric?: boolean;
  backDistance?: ParamValue;
  operation?: ExtrudeChoice['operation'];
  targetBodyId?: BodyId;
  endCondition?: ExtrudeEndCondition;
  throughAllSide?: ThroughAllSide;
  toFace?: ExtrudeToFaceTarget;
  toFaceOffset?: ParamValue;
  startOffset?: ParamValue;
  draftAngleDeg?: ParamValue;
  backDraftAngleDeg?: ParamValue;
}

/** What the rules read beyond the draft itself. */
export interface ExtrudeDraftContext {
  scope: Record<string, number>;
  units: UnitSystem;
  initial: ExtrudeDraftInitial;
  bodies: readonly { bodyId: BodyId; name: string }[];
  /** Absent: To face is not offered (no host to pick the face with). */
  toFacePicking?: ExtrudeToFacePicking;
}

/** The steepest draft an extrude takes; the schema's own bound. */
export const MAX_DRAFT_DEG = MAX_EXTRUDE_DRAFT_DEG;

export function initialExtrudeDraft(
  initial: ExtrudeDraftInitial,
  creating: boolean
): ExtrudeDraft {
  return {
    name: initial.name,
    distance: paramValueText(initial.distance),
    symmetric: initial.symmetric === true,
    backDistance: paramValueText(initial.backDistance ?? 0),
    choice: {
      operation: initial.operation ?? (creating ? 'automatic' : 'new-body'),
      ...(initial.targetBodyId ? { targetBodyId: initial.targetBodyId } : {})
    },
    endCondition: initial.endCondition ?? 'blind',
    throughAllSide: initial.throughAllSide ?? 'forward',
    ...(initial.toFace ? { toFace: initial.toFace } : {}),
    faceOffset: paramValueText(initial.toFaceOffset ?? 0),
    startOffset: paramValueText(initial.startOffset ?? 0),
    draftAngle: paramValueText(initial.draftAngleDeg ?? 0),
    backDraftAngle: paramValueText(initial.backDraftAngleDeg ?? 0)
  };
}

function lengthOf(ctx: ExtrudeDraftContext) {
  return { documentUnits: ctx.units, dimension: 'length' } as const;
}

function angleOf(ctx: ExtrudeDraftContext) {
  return { documentUnits: ctx.units, dimension: 'angle' } as const;
}

/** A field's text as a number, or null when it does not evaluate. */
export function extrudeDraftNumber(
  text: string,
  kind: 'length' | 'angle',
  ctx: ExtrudeDraftContext
): number | null {
  const preview = previewExpression(
    text,
    ctx.scope,
    kind === 'angle' ? angleOf(ctx) : lengthOf(ctx)
  );
  return preview.ok && preview.value !== undefined ? preview.value : null;
}

/** Through all needs one explicit cut target, so only Cut offers it. */
export function extrudeOffersThroughAll(draft: ExtrudeDraft): boolean {
  return draft.choice.operation === 'cut';
}

export function extrudeIsThroughAll(draft: ExtrudeDraft): boolean {
  return (
    draft.choice.operation === 'cut' && draft.endCondition === 'through-all'
  );
}

/** F01 (v29): to-face replaces the distance with a picked face. */
export function extrudeIsToFace(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): boolean {
  return ctx.toFacePicking !== undefined && draft.endCondition === 'to-face';
}

/** The extent as the editor shows it: through all reads as Distance off Cut. */
export function extrudeShownExtent(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): ExtrudeEndCondition {
  if (extrudeIsThroughAll(draft) || extrudeIsToFace(draft, ctx)) {
    return draft.endCondition;
  }
  return draft.endCondition === 'through-all' ? 'blind' : draft.endCondition;
}

/**
 * A picked face the build would refuse (not parallel to the sketch, or lying
 * on the sketch plane with no start offset to reach it from), said before
 * Apply rather than after; null when there is none.
 */
export function extrudeToFaceProblem(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): string | null {
  if (!extrudeIsToFace(draft, ctx) || !draft.toFace) return null;
  const info = ctx.toFacePicking!.describe(draft.toFace);
  if (info.distance === 0) {
    const start = extrudeDraftNumber(draft.startOffset, 'length', ctx);
    return start === 0
      ? 'This face lies on the sketch plane; give a start offset or pick another face.'
      : null;
  }
  if (info.distance !== null) return null;
  return (
    info.problem ??
    (info.pending
      ? 'Checking the target face…'
      : 'This face is not parallel to the sketch plane; pick a face parallel to the sketch.')
  );
}

/**
 * F01 (v113, v121): where a to-face extrusion would sweep from its start to
 * the face less its offset, by the build's own rule ({@link toFaceExtent});
 * a refusal when that leaves nothing, else null. Null too while the face's
 * reach or either value is not known yet (the build decides then).
 */
function extrudeToFaceExtentRefusal(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): { start: boolean; message: string } | null {
  if (!extrudeIsToFace(draft, ctx) || !draft.toFace) return null;
  const offset = extrudeDraftNumber(draft.faceOffset, 'length', ctx);
  const start = extrudeDraftNumber(draft.startOffset, 'length', ctx);
  if (offset === null || start === null) return null;
  const reach = ctx.toFacePicking!.describe(draft.toFace).distance;
  if (reach === null || (reach === 0 && start === 0)) return null;
  if (toFaceExtent(reach, start, offset) !== null) return null;
  if (start === 0) {
    return {
      start: false,
      message:
        'Offset from face reaches the sketch plane; make it smaller than the distance to the face.'
    };
  }
  return Math.abs(reach - start) <= 1e-9 * Math.max(1, Math.abs(reach))
    ? {
        start: true,
        message: 'Start offset reaches the face; move the start off the face.'
      }
    : {
        start: false,
        message:
          'Offset from face reaches where the extrusion starts; make it smaller than the distance from the start to the face.'
      };
}

/** F01 (v113): an offset from the face that leaves nothing to extrude. */
export function extrudeToFaceOffsetProblem(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): string | null {
  const refusal = extrudeToFaceExtentRefusal(draft, ctx);
  return refusal && !refusal.start ? refusal.message : null;
}

/** F01 (v121): a start offset that lands on the face. */
export function extrudeStartOffsetProblem(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): string | null {
  const refusal = extrudeToFaceExtentRefusal(draft, ctx);
  return refusal && refusal.start ? refusal.message : null;
}

/** The stored face no longer resolves and has not been picked again. */
export function extrudeToFaceUnresolved(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): boolean {
  return (
    ctx.toFacePicking?.unresolved === true &&
    draft.toFace === ctx.initial.toFace
  );
}

/**
 * F01 (v126): whether a blind draft has a side behind the sketch plane for
 * a back draft to taper: symmetric, or a back distance.
 */
export function extrudeHasBackSide(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): boolean {
  if (extrudeIsThroughAll(draft) || extrudeIsToFace(draft, ctx)) return false;
  if (draft.symmetric) return true;
  const back = extrudeDraftNumber(draft.backDistance, 'length', ctx);
  return back !== null && back !== 0;
}

/**
 * Why a draft angle cannot apply as typed, or null. An angle at a right
 * angle has no finite taper; from v126 the front draft applies to every
 * extent but through all (the caller skips it there), and the back draft
 * needs a back side to taper.
 */
export function extrudeDraftAngleError(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): string | null {
  const angle = extrudeDraftNumber(draft.draftAngle, 'angle', ctx);
  if (angle !== null && Math.abs(angle) >= MAX_DRAFT_DEG) {
    return `Draft must be between -${MAX_DRAFT_DEG}° and ${MAX_DRAFT_DEG}°.`;
  }
  const back = extrudeDraftNumber(draft.backDraftAngle, 'angle', ctx);
  if (back === null || back === 0) return null;
  if (Math.abs(back) >= MAX_DRAFT_DEG) {
    return `Back draft must be between -${MAX_DRAFT_DEG}° and ${MAX_DRAFT_DEG}°.`;
  }
  if (!extrudeHasBackSide(draft, ctx)) {
    return 'Back draft tapers the side behind the sketch plane; turn on Symmetric or give a back distance first.';
  }
  return null;
}

/** An add, cut or intersect needs the body it acts on. */
export function extrudeNeedsTarget(choice: ExtrudeChoice): boolean {
  return (
    choice.operation === 'add' ||
    choice.operation === 'cut' ||
    choice.operation === 'intersect'
  );
}

/** The choice with `operation` picked, keeping (or guessing) its target. */
export function extrudeChoiceWith(
  choice: ExtrudeChoice,
  operation: ExtrudeChoice['operation'],
  bodies: readonly { bodyId: BodyId }[]
): ExtrudeChoice {
  if (operation !== 'add' && operation !== 'cut' && operation !== 'intersect') {
    return { operation };
  }
  const kept =
    extrudeNeedsTarget(choice) && 'targetBodyId' in choice
      ? choice.targetBodyId
      : undefined;
  return {
    operation,
    ...(kept
      ? { targetBodyId: kept }
      : bodies.length === 1
        ? { targetBodyId: bodies[0]!.bodyId }
        : {})
  };
}

/** What Create or Apply stores, whether or not the draft can apply yet. */
export function extrudeFormValue(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): ExtrudeFormValue {
  const throughAll = extrudeIsThroughAll(draft);
  const toFace = extrudeIsToFace(draft, ctx);
  const derived = throughAll || toFace;
  // A through-all cut and a to-face extrude derive their span in the build,
  // so the distance is dormant; a create still needs it non-zero, so an
  // untouched 0 sends 1.
  const typed = coerceParamValue(draft.distance);
  const draftAngleDeg = coerceParamValue(draft.draftAngle);
  const backDraftAngleDeg = coerceParamValue(draft.backDraftAngle);
  const toFaceOffset = coerceParamValue(draft.faceOffset);
  const startOffset = coerceParamValue(draft.startOffset);
  return {
    name: draft.name.trim(),
    sketchId: ctx.initial.sketchId,
    // A dormant zero in any form (`0 mm`, a parameter at 0) sends 1 too.
    distance:
      derived &&
      (!typed ||
        previewExpression(draft.distance, ctx.scope, lengthOf(ctx)).value === 0)
        ? 1
        : typed,
    symmetric: derived ? false : draft.symmetric,
    // Symmetric sends no back distance at all: the document reads any
    // non-zero one beside it as a two-sided conflict (F002).
    ...(!derived && draft.symmetric
      ? {}
      : {
          backDistance: derived ? 0 : coerceParamValue(draft.backDistance)
        }),
    choice: draft.choice,
    endCondition: throughAll ? 'through-all' : toFace ? 'to-face' : 'blind',
    ...(throughAll ? { throughAllSide: draft.throughAllSide } : {}),
    ...(toFace && draft.toFace ? { toFace: draft.toFace } : {}),
    ...(toFace && toFaceOffset !== 0 && toFaceOffset !== '0'
      ? { toFaceOffset }
      : {}),
    ...(!throughAll && startOffset !== 0 && startOffset !== '0'
      ? { startOffset }
      : {}),
    ...(!throughAll && draftAngleDeg !== 0 && draftAngleDeg !== '0'
      ? { draftAngleDeg }
      : {}),
    ...(!derived && backDraftAngleDeg !== 0 && backDraftAngleDeg !== '0'
      ? { backDraftAngleDeg }
      : {})
  };
}

/** What Create or Apply would store, or null while the draft cannot apply. */
export function extrudeDraftValue(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext
): ExtrudeFormValue | null {
  return extrudeDraftRefusal(draft, ctx, true) === null
    ? extrudeFormValue(draft, ctx)
    : null;
}

/**
 * Why the draft cannot apply yet, or null when it can. `distanceEdited`:
 * a new extrude opens at zero, which is not a mistake until the distance is
 * edited (or a submit is tried), so before that it is refused with an empty
 * reason: the draft still cannot apply, and there is nothing to say yet.
 */
export function extrudeDraftRefusal(
  draft: ExtrudeDraft,
  ctx: ExtrudeDraftContext,
  distanceEdited: boolean
): string | null {
  const throughAll = extrudeIsThroughAll(draft);
  const toFace = extrudeIsToFace(draft, ctx);
  if (!draft.name.trim()) return 'Name the extrude.';
  if (toFace) {
    if (!draft.toFace) return 'Pick the face for the extrusion to reach.';
    // A face stored on the sketch plane with no start offset is refused as
    // unresolved; a start offset typed now reaches it without a re-pick.
    const reachable =
      ctx.toFacePicking!.describe(draft.toFace).distance === 0 &&
      (extrudeDraftNumber(draft.startOffset, 'length', ctx) ?? 0) !== 0;
    if (extrudeToFaceUnresolved(draft, ctx) && !reachable) {
      return 'The target face no longer exists here; pick a face again.';
    }
    const problem = extrudeToFaceProblem(draft, ctx);
    if (problem) return problem;
    const offset = previewExpression(
      draft.faceOffset,
      ctx.scope,
      lengthOf(ctx)
    );
    if (!offset.ok || offset.value === undefined) {
      return `Offset from face: ${offset.text}.`;
    }
    const offsetProblem = extrudeToFaceOffsetProblem(draft, ctx);
    if (offsetProblem) return offsetProblem;
  }
  if (!throughAll) {
    const start = previewExpression(
      draft.startOffset,
      ctx.scope,
      lengthOf(ctx)
    );
    if (!start.ok || start.value === undefined) {
      return `Start offset: ${start.text}.`;
    }
    const startProblem = extrudeStartOffsetProblem(draft, ctx);
    if (startProblem) return startProblem;
    const angle = previewExpression(draft.draftAngle, ctx.scope, angleOf(ctx));
    if (!angle.ok || angle.value === undefined) {
      return `Draft angle: ${angle.text}.`;
    }
    if (!toFace) {
      const back = previewExpression(
        draft.backDraftAngle,
        ctx.scope,
        angleOf(ctx)
      );
      if (!back.ok || back.value === undefined) {
        return `Back draft angle: ${back.text}.`;
      }
    }
    const error = extrudeDraftAngleError(draft, ctx);
    if (error) return error;
  }
  // Through all and to-face ignore the distance; it is kept only for
  // switching back to blind, so it cannot block Apply.
  if (!throughAll && !toFace) {
    const distance = previewExpression(
      draft.distance,
      ctx.scope,
      lengthOf(ctx)
    );
    if (!distance.ok || distance.value === undefined) {
      return `Distance: ${distance.text}.`;
    }
    if (distance.value === 0) {
      return distanceEdited
        ? 'Distance cannot be zero — a zero-distance extrude builds no solid.'
        : '';
    }
    if (!draft.symmetric) {
      const back = previewExpression(
        draft.backDistance,
        ctx.scope,
        lengthOf(ctx)
      );
      if (!back.ok || back.value === undefined) {
        return `Back distance: ${back.text}.`;
      }
      if (back.value < 0) return 'Back distance cannot be negative.';
    }
  }
  // The document's own sides rule, on what Done would store: the form never
  // pairs Symmetric with a back distance, and Done stays off if it ever did.
  const value = extrudeFormValue(draft, ctx);
  if (
    extrudeSidesConflict(value, (text) =>
      extrudeDraftNumber(paramValueText(text), 'length', ctx)
    )
  ) {
    return EXTRUDE_SIDES_CONFLICT_MESSAGE;
  }
  if (extrudeNeedsTarget(draft.choice)) {
    const targetBodyId =
      'targetBodyId' in draft.choice ? draft.choice.targetBodyId : undefined;
    if (!ctx.bodies.some((body) => body.bodyId === targetBodyId)) {
      return 'Select a target before applying.';
    }
  }
  return null;
}

/**
 * The distance with its direction flipped. A negated expression is unwrapped
 * rather than wrapped again, so Reverse twice reads as it started instead of
 * `-(-(10/2))`.
 */
export function reversedDistance(distance: string): string {
  const text = distance.trim();
  if (Number.isFinite(Number(text))) {
    return String(-Number(text));
  }
  if (text.startsWith('-(') && text.endsWith(')')) {
    // Only when that first parenthesis closes at the very end: `-(a)*(b)`
    // is not a negation of everything after the minus.
    let depth = 0;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (depth === 0) {
        if (index === text.length - 1) return text.slice(2, -1).trim();
        break;
      }
    }
  }
  return `-(${text})`;
}

/**
 * A picked face's reach as the dormant distance: rounded for the field, but
 * never through zero, so a reach shorter than the rounding keeps its exact
 * value and its sign (which side of the sketch the face is on).
 */
export function toFaceReachText(reach: number): string {
  const rounded = Math.round(reach * 1e6) / 1e6;
  return String(rounded === 0 ? reach : rounded);
}
