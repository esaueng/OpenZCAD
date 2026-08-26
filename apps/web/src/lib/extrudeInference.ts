import { commandFactories } from '@openzcad/command-system';
import type { ExtrudeInput } from '@openzcad/document-core';
import {
  classifyExtrudeOperation,
  extrudeBoundsCanShareVolume,
  type ExtrudeInferenceBody,
  type ExtrudeOperationInference,
  type ExtrudeUnionMeasurement
} from '@openzcad/kernel-adapter';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

type DerivedState = ProjectDocument['derived'];
type ExtrudeCommand = ReturnType<typeof commandFactories.extrudeSketch>;

export interface ResolvedExtrude {
  command: ExtrudeCommand;
  document: ProjectDocument;
  derived: DerivedState;
  inference: ExtrudeOperationInference;
  baseVersion: number;
}

export interface ResolveExtrudeOptions {
  base: ProjectDocument;
  input: ExtrudeInput;
  derive(document: ProjectDocument): Promise<DerivedState>;
  /**
   * For a sketch attached to a body's face whose extrusion runs into that
   * body (negative distance along the face's outward normal). Direction
   * carries the user's intent where volume measurement alone is ambiguous:
   * a profile overhanging the rim dragged inward partially overlaps — which
   * reads as "add" — but the gesture means cut. (The mirror case, joining a
   * boss grown off a face, is blocked at the document layer: a stored add
   * with zero shared volume is refused by the exact rebuild.)
   */
  faceAttachment?: { bodyId: BodyId; direction: 'into' };
}

function withOperation(
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
  if (
    attachment &&
    inference.operation === 'add' &&
    inference.targetBodyId === attachment.bodyId
  ) {
    inference = { ...inference, operation: 'cut', reason: 'into-face-body' };
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
