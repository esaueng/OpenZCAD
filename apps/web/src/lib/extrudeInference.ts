import { commandFactories } from '@openzcad/command-system';
import type { ExtrudeInput } from '@openzcad/document-core';
import {
  classifyExtrudeOperation,
  extrudeBoundsCanShareVolume,
  type ExtrudeInferenceBody,
  type ExtrudeOperationInference,
  type ExtrudeUnionMeasurement
} from '@openzcad/kernel-adapter/extrude-inference';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

type DerivedState = ProjectDocument['derived'];
type ExtrudeCommand = ReturnType<typeof commandFactories.extrudeSketch>;

export interface ResolvedExtrude {
  command: ExtrudeCommand;
  document: ProjectDocument;
  derived: DerivedState;
  inference: Omit<ExtrudeOperationInference, 'reason'> & {
    reason: ExtrudeOperationInference['reason'] | 'explicit';
  };
  baseVersion: number;
}

export type ExtrudeChoice =
  | { operation: 'automatic' }
  | { operation: 'new-body' }
  | { operation: 'add' | 'cut'; targetBodyId?: BodyId };

export interface ResolveExtrudeOptions {
  choice?: ExtrudeChoice;
  base: ProjectDocument;
  input: ExtrudeInput;
  derive(document: ProjectDocument): Promise<DerivedState>;
  /**
   * For a sketch attached to a body's face: which body, and which way the
   * extrusion runs along that face's outward normal. Direction carries the
   * user's intent where volume measurement alone cannot. Into the body, a
   * profile overhanging the rim only partially overlaps — which measures as
   * "add" — but the gesture means cut. Away from it, a boss meets its target
   * exactly at the sketched face and shares no volume at all, so the
   * measurement says new-body while the gesture means join.
   */
  faceAttachment?: { bodyId: BodyId; direction: 'into' | 'away' };
}

/** Rewrites an extrude input's stored operation without touching the rest. */
export function withOperation(
  input: ExtrudeInput,
  operation: 'new-body' | 'add' | 'cut',
  targetBodyId?: BodyId
): ExtrudeInput {
  const { operation: _operation, targetBodyId: _target, ...rest } = input;
  return {
    ...rest,
    operation,
    ...(targetBodyId === undefined ? {} : { targetBodyId })
  };
}

function inferenceBody(
  bodyId: BodyId,
  derived: DerivedState
): ExtrudeInferenceBody | null {
  const body = derived.bodyRepresentations[bodyId];
  return body
    ? {
        bodyId,
        name: body.name,
        volume: body.volume,
        bbox: body.bbox
      }
    : null;
}

function isMeasuredZeroOverlap(
  derived: DerivedState,
  featureName: string,
  target: ExtrudeInferenceBody,
  baselineWarnings: readonly string[]
): boolean {
  const expected =
    `Feature "${featureName}": Stored add extrusion no longer overlaps ` +
    `${target.name}; operation was not re-inferred.`;
  return (
    derived.bodyRepresentations[target.bodyId]?.consumed === false &&
    derived.warnings.filter((warning) => warning === expected).length >
      baselineWarnings.filter((warning) => warning === expected).length
  );
}

/**
 * Resolve an extrusion once from exact union measurements, then rebuild the
 * stored result operation. Every geometry call remains in the browser worker.
 */
export async function resolveExtrudeOperation(
  options: ResolveExtrudeOptions
): Promise<ResolvedExtrude> {
  const reserved = commandFactories.extrudeSketch(options.input).payload;
  const resultBodyId = reserved.ids?.bodyId;
  if (!resultBodyId) {
    throw new Error('Extrude could not reserve a result body.');
  }

  const choice = options.choice;
  if (choice && choice.operation !== 'automatic') {
    const targetBodyId =
      choice.operation === 'new-body' ? undefined : choice.targetBodyId;
    if (choice.operation !== 'new-body' && !targetBodyId) {
      throw new Error(
        `Select a target body for ${choice.operation === 'cut' ? 'Cut' : 'Add'}.`
      );
    }
    if (targetBodyId) {
      const target = options.base.derived.bodyRepresentations[targetBodyId];
      if (!target || target.consumed) {
        throw new Error(
          'The selected extrusion target is no longer available. Select a target body.'
        );
      }
    }
    const command = commandFactories.extrudeSketch(
      withOperation(reserved, choice.operation, targetBodyId)
    );
    command.validate(options.base);
    const document = command.apply(options.base);
    const derived = await options.derive(document);
    if (!derived.bodyRepresentations[resultBodyId]) {
      throw new Error(
        derived.warnings.at(-1) ??
          'The selected extrusion operation did not produce an exact result body.'
      );
    }
    return {
      command,
      document,
      derived,
      baseVersion: options.base.version,
      inference: {
        operation: choice.operation,
        ...(targetBodyId ? { targetBodyId } : {}),
        reason: 'explicit',
        tolerance: 0
      }
    };
  }

  const newBodyCommand = commandFactories.extrudeSketch(
    withOperation(reserved, 'new-body')
  );
  newBodyCommand.validate(options.base);
  const newBodyDocument = newBodyCommand.apply(options.base);
  const newBodyDerived = await options.derive(newBodyDocument);
  const extrusion = inferenceBody(resultBodyId, newBodyDerived);
  if (!extrusion) {
    throw new Error('Extrude preview did not produce an exact result body.');
  }

  const liveTargets = options.base.bodyOrder.flatMap((bodyId) => {
    const body = inferenceBody(bodyId, newBodyDerived);
    const rendered = newBodyDerived.bodyRepresentations[bodyId];
    return body && rendered && !rendered.consumed ? [body] : [];
  });
  const candidates = liveTargets.filter((target) =>
    extrudeBoundsCanShareVolume(extrusion.bbox, target.bbox)
  );
  const measurements: ExtrudeUnionMeasurement[] = [];
  const unresolved: ExtrudeInferenceBody[] = [];
  const addPreviews = new Map<BodyId, ResolvedExtrude>();

  for (const target of candidates) {
    try {
      const command = commandFactories.extrudeSketch(
        withOperation(reserved, 'add', target.bodyId)
      );
      command.validate(options.base);
      const document = command.apply(options.base);
      const derived = await options.derive(document);
      const result = inferenceBody(resultBodyId, derived);
      if (!result) {
        // The stored-add rebuild deliberately omits a result when its exact
        // common-volume measurement is zero. For inference that is a valid
        // measurement, not a kernel refusal: record the disjoint union volume
        // so a bounding-box-only decoy cannot veto another unambiguous target.
        if (
          isMeasuredZeroOverlap(
            derived,
            command.payload.name,
            target,
            newBodyDerived.warnings
          )
        ) {
          measurements.push({
            target,
            unionVolume: target.volume + extrusion.volume
          });
          continue;
        }
        throw new Error('Stored add preview produced no exact result body.');
      }
      measurements.push({ target, unionVolume: result.volume });
      addPreviews.set(target.bodyId, {
        command,
        document,
        derived,
        inference: {
          operation: 'add',
          targetBodyId: target.bodyId,
          targetBodyName: target.name,
          reason: 'partial-overlap',
          tolerance: 0
        },
        baseVersion: options.base.version
      });
    } catch {
      unresolved.push(target);
    }
  }

  let inference = classifyExtrudeOperation(
    extrusion,
    measurements,
    unresolved,
    liveTargets.length
  );
  const attachment = options.faceAttachment;
  if (attachment?.direction === 'into') {
    if (
      inference.operation === 'add' &&
      inference.targetBodyId === attachment.bodyId
    ) {
      inference = { ...inference, operation: 'cut', reason: 'into-face-body' };
    }
  } else if (attachment?.direction === 'away') {
    // A boss touching only at the sketched face never reaches the candidate
    // list — tangency fails the bounds test — so the target is taken from the
    // live bodies directly. The exact rebuild still has the final say: it
    // refuses an add whose operands do not even touch.
    if (
      inference.operation === 'new-body' &&
      inference.reason === 'no-overlap'
    ) {
      const target = liveTargets.find(
        (candidate) => candidate.bodyId === attachment.bodyId
      );
      if (target) {
        inference = {
          ...inference,
          operation: 'add',
          targetBodyId: target.bodyId,
          targetBodyName: target.name,
          reason: 'onto-face-body'
        };
      }
    }
  }
  if (inference.operation === 'new-body') {
    return {
      command: newBodyCommand,
      document: newBodyDocument,
      derived: newBodyDerived,
      inference,
      baseVersion: options.base.version
    };
  }

  if (inference.operation === 'add' && inference.targetBodyId) {
    const preview = addPreviews.get(inference.targetBodyId);
    if (preview) {
      return { ...preview, inference };
    }
  }

  if (!inference.targetBodyId) {
    throw new Error('Inferred extrusion operation has no target body.');
  }
  const command = commandFactories.extrudeSketch(
    withOperation(reserved, inference.operation, inference.targetBodyId)
  );
  command.validate(options.base);
  const document = command.apply(options.base);
  const derived = await options.derive(document);
  if (!derived.bodyRepresentations[resultBodyId]) {
    throw new Error('Inferred extrusion did not produce an exact result body.');
  }
  return {
    command,
    document,
    derived,
    inference,
    baseVersion: options.base.version
  };
}

type OperationInference = Pick<
  ResolvedExtrude['inference'],
  'operation' | 'targetBodyId'
>;

const OPERATION_PHRASES: Record<OperationInference['operation'], string> = {
  cut: 'cut into the body',
  add: 'add to the body',
  'new-body': 'make a new body'
};

/**
 * The refusal for selected profiles that would not extrude the same way on
 * their own, or null when they agree.
 *
 * One drag extrudes every selected profile by the same value as one feature
 * with one operation. Classified together, a profile over the body and one
 * beside it measure as a partial overlap and silently become an add, so the
 * pocket the user dragged never appears. Agreement is checked instead, and a
 * mix is refused in one sentence that says how to get each result.
 */
export function mixedExtrudeRefusal(
  inferences: readonly OperationInference[]
): string | null {
  const operations: OperationInference['operation'][] = [];
  for (const inference of inferences) {
    if (!operations.includes(inference.operation)) {
      operations.push(inference.operation);
    }
  }
  if (operations.length === 2) {
    return (
      `One selected profile would ${OPERATION_PHRASES[operations[0]!]} and ` +
      `another would ${OPERATION_PHRASES[operations[1]!]}, so extrude them ` +
      'separately or choose an operation.'
    );
  }
  if (operations.length > 2) {
    return (
      'The selected profiles would cut, add and make a new body at once, so ' +
      'extrude them separately or choose an operation.'
    );
  }
  const targets = new Set(
    inferences.map((inference) => inference.targetBodyId ?? null)
  );
  if (targets.size > 1) {
    return (
      `The selected profiles would ${operations[0] === 'cut' ? 'cut' : 'add to'} ` +
      'different bodies, so extrude them separately or choose the target body.'
    );
  }
  return null;
}

/**
 * Combined verdicts every part of the extrusion necessarily shares. Inside one
 * body as a whole means each profile is inside it; touching nothing as a whole
 * means each profile touches nothing (and grows onto the sketched face alike).
 * Only a mixed verdict — partial overlap and what is derived from it — can
 * hide profiles that disagree.
 */
const UNIFORM_REASONS: ReadonlySet<ResolvedExtrude['inference']['reason']> =
  new Set([
    'explicit',
    'enclosed',
    'no-overlap',
    'no-live-body',
    'onto-face-body'
  ]);

/**
 * Infers each profile reference of an automatic extrusion on its own and
 * returns the refusal when they disagree (see `mixedExtrudeRefusal`).
 *
 * `combined` is the verdict for the whole selection. When it is one every
 * profile must share, the per-profile rebuilds are skipped, so a plate of
 * pockets pays nothing extra. An explicit operation is the user's answer to
 * the question and is never second-guessed; one reference — a single region,
 * or a whole text object — has nothing to disagree with. A profile whose own
 * inference fails proves nothing either way and is left to the combined
 * build to report.
 */
export async function regionInferenceRefusal(
  options: ResolveExtrudeOptions,
  combined: Pick<ResolvedExtrude['inference'], 'reason'>
): Promise<string | null> {
  if (
    (options.choice && options.choice.operation !== 'automatic') ||
    UNIFORM_REASONS.has(combined.reason)
  ) {
    return null;
  }
  const profiles = options.input.profiles ?? [];
  if (profiles.length < 2) {
    return null;
  }
  const inferences: OperationInference[] = [];
  for (const profile of profiles) {
    try {
      const resolved = await resolveExtrudeOperation({
        ...options,
        input: { ...options.input, profiles: [profile] }
      });
      inferences.push(resolved.inference);
    } catch {
      // Unknown, not a disagreement.
    }
  }
  return mixedExtrudeRefusal(inferences);
}

/** A discarded command must not publish a late result or refusal. */
export async function resolveCurrentExtrude(
  options: ResolveExtrudeOptions,
  isCurrent: () => boolean
): Promise<ResolvedExtrude | null> {
  if (!isCurrent()) return null;
  try {
    const resolved = await resolveExtrudeOperation(options);
    return isCurrent() ? resolved : null;
  } catch (error) {
    if (!isCurrent()) return null;
    throw error;
  }
}
