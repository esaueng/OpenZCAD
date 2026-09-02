/**
 * Replays one fixture against the exact kernel and reports what the app's own
 * fail-closed gates would have said.
 *
 * The refusal text comes from the shipped gates (`directEditRejection`,
 * `validatedFeatureRejection`), not from a corpus-local reimplementation, so a
 * pin records the sentence a user actually saw.
 */

import { commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  normalizeDocument
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type {
  BodyId,
  EdgeTopology,
  EdgeTopologyReferenceV5,
  FaceTopology,
  ProjectDocument
} from '@openzcad/shared';

import { directEditRejection } from '../../apps/web/src/lib/directEdit';
import { validatedFeatureRejection } from '../../apps/web/src/lib/featureValidation';
import type {
  DirectEditFixture,
  DirectEditFixtureEdge
} from '../../apps/web/src/lib/directEditFixture';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';
import { resolveFixtureEdges, resolveFixtureFace } from './resolve';

/**
 * Which way the app sent a face offset: to the primitive dimension the face
 * rides on, or to the generic exact push/pull. Only an `offset-face` fixture
 * has a route; a fillet or chamfer replay is not a routing decision at all.
 */
export type FaceOffsetRoute = 'primitive-dimension' | 'direct-edit';

export interface ReplayResult {
  outcome: 'committed' | 'refused';
  /** The refusal, via directEditRejection / validatedFeatureRejection. */
  message?: string;
  volumeBefore: number;
  volumeAfter?: number;
  warnings: string[];
  route?: FaceOffsetRoute;
}

const FILLET_FEATURE_NAME = 'Fillet edges';
const CHAMFER_FEATURE_NAME = 'Chamfer edges';
const DIRECT_EDIT_FEATURE_NAME = 'Offset face';
const RESIZE_FEATURE_NAME = 'Resize cylindrical face';

/**
 * A capture that recorded a pick WITHOUT a v5 reference must replay without
 * one, or the corpus would silently upgrade a hash-only lineage case into the
 * semantic path and stop measuring the class it was captured for.
 */
function referenceFor<T>(
  resolved: T | undefined,
  hasReference: boolean
): T | undefined {
  return hasReference ? resolved : undefined;
}

/** The same face with its v5 reference dropped, for a hash-only replay. */
function withoutReference(face: FaceTopology): FaceTopology {
  const { reference: _reference, ...rest } = face;
  return rest;
}

function edgeReferences(
  resolved: readonly EdgeTopology[],
  recorded: readonly DirectEditFixtureEdge[]
): EdgeTopologyReferenceV5[] {
  return resolved.flatMap((edge, index) => {
    const reference = referenceFor(
      edge.reference,
      recorded[index]?.hasReference ?? true
    );
    return reference ? [reference] : [];
  });
}

function requireFaceGeometry(
  face: FaceTopology
): NonNullable<FaceTopology['geometry']> {
  const geometry = face.geometry;
  if (!geometry) {
    throw new Error('The resolved face publishes no geometry to edit.');
  }
  return geometry;
}

export async function replayFixture(
  adapter: ExactKernelAdapter,
  fixture: DirectEditFixture
): Promise<ReplayResult> {
  if (fixture.document === null) {
    throw new Error(
      `Fixture "${fixture.name}" carries no document (documentOmitted: ` +
        `${fixture.documentOmitted ?? 'unstated'}); it cannot be replayed.`
    );
  }
  const document = normalizeDocument(fixture.document);
  const targetBodyId = fixture.edit.targetBodyId as BodyId;
  const before = await adapter.syncDocument(document);
  const body = before.bodyRepresentations[targetBodyId];
  if (!body) {
    throw new Error(
      `Fixture "${fixture.name}": the pre-edit rebuild produced no body ` +
        `${targetBodyId}. Warnings: ${JSON.stringify(before.warnings)}`
    );
  }
  const volumeBefore = body.volume;

  const { command, featureName, resultBodyId, gate, route } = buildCommand(
    fixture,
    document,
    body,
    targetBodyId
  );

  command.validate(document);
  const next: ProjectDocument = command.apply(document);
  const after = await adapter.syncDocument(next);
  const resultBody = after.bodyRepresentations[resultBodyId];
  const bodyPresent = resultBody !== undefined;

  const message =
    gate === 'direct-edit'
      ? directEditRejection({
          label: command.label,
          warnings: after.warnings,
          featureWarnings: after.featureWarnings,
          bodyPresent,
          documentMoved: false
        })
      : (validatedFeatureRejection({
          featureName,
          warnings: after.warnings,
          featureWarnings: after.featureWarnings,
          bodyPresent,
          documentMoved: false
        })?.message ?? null);

  return {
    outcome: message === null ? 'committed' : 'refused',
    ...(message === null ? {} : { message }),
    volumeBefore,
    ...(resultBody ? { volumeAfter: resultBody.volume } : {}),
    warnings: after.warnings,
    ...(route ? { route } : {})
  };
}

interface BuiltCommand {
  command: {
    label: string;
    validate(document: ProjectDocument): void;
    apply(document: ProjectDocument): ProjectDocument;
  };
  featureName: string;
  resultBodyId: BodyId;
  gate: 'direct-edit' | 'feature';
  route?: FaceOffsetRoute;
}

function buildCommand(
  fixture: DirectEditFixture,
  document: ProjectDocument,
  body: Parameters<typeof resolveFixtureFace>[0],
  targetBodyId: BodyId
): BuiltCommand {
  const { edit } = fixture;
  switch (edit.op) {
    case 'offset-face': {
      const recorded = requireFacePick(fixture);
      const face = resolveFixtureFace(body, recorded);
      const geometry = requireFaceGeometry(face);
      if (geometry.normal === undefined) {
        throw new Error('An offset needs an exact planar normal.');
      }
      // The app's own routing decision, not a corpus-local reimplementation,
      // so a fixture measures the gesture the product actually performs. A
      // capture that recorded a hash-only pick still replays hash-only, which
      // is what keeps it on the local push/pull the class was captured for.
      const reference = referenceFor(face.reference, recorded.hasReference);
      const faceForPlan: FaceTopology = reference
        ? face
        : withoutReference(face);
      const plan = planFaceOffset({
        document,
        bodyId: targetBodyId,
        face: faceForPlan,
        faceHash: face.hash,
        offset: edit.value
      });
      if (!plan) {
        throw new Error(
          `Fixture "${fixture.name}": the planner refused the pick — a planar ` +
            'face and a non-zero offset are both required.'
        );
      }
      if (plan.kind === 'primitive-dimension') {
        return {
          command: plan.command,
          featureName: plan.primitive.name,
          resultBodyId: targetBodyId,
          gate: 'feature',
          route: 'primitive-dimension'
        };
      }
      return {
        command: plan.command,
        featureName: DIRECT_EDIT_FEATURE_NAME,
        resultBodyId: targetBodyId,
        gate: 'direct-edit',
        route: 'direct-edit'
      };
    }
    case 'resize-cylinder-radius': {
      const recorded = requireFacePick(fixture);
      const face = resolveFixtureFace(body, recorded);
      const geometry = requireFaceGeometry(face);
      const { radius, axisStart, axisEnd } = geometry;
      if (radius === undefined || !axisStart || !axisEnd) {
        throw new Error(
          'A cylindrical resize needs an exact radius and axis on the resolved face.'
        );
      }
      const reference = referenceFor(face.reference, recorded.hasReference);
      return {
        command: commandFactories.directEditBody({
          name: RESIZE_FEATURE_NAME,
          targetBodyId,
          operation: {
            kind: 'resize-cylindrical-face',
            faceHash: face.hash,
            ...(reference ? { faceReference: reference } : {}),
            sourceRadius: radius,
            sourceAxisStart: axisStart,
            sourceAxisEnd: axisEnd,
            // Replay has no drag ray to test the wall's facing direction
            // against, so the kernel's own proven role is the only evidence.
            concavity:
              geometry.featureType === 'through-hole' ? 'hole' : 'boss',
            radius: edit.value
          }
        }),
        featureName: RESIZE_FEATURE_NAME,
        resultBodyId: targetBodyId,
        gate: 'direct-edit'
      };
    }
    case 'fillet':
    case 'chamfer': {
      const recorded = edit.edges;
      if (!recorded || recorded.length === 0) {
        throw new Error(
          `Fixture "${fixture.name}": a ${edit.op} needs at least one recorded edge.`
        );
      }
      const edges = resolveFixtureEdges(body, recorded);
      const references = edgeReferences(edges, recorded);
      const ids = createBodyFeatureIds();
      const name =
        edit.op === 'fillet' ? FILLET_FEATURE_NAME : CHAMFER_FEATURE_NAME;
      const payload = {
        name,
        targetBodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        ...(references.length > 0 ? { edgeReferences: references } : {}),
        size: edit.value,
        ids
      };
      return {
        command:
          edit.op === 'fillet'
            ? commandFactories.filletEdges(payload)
            : commandFactories.chamferEdges(payload),
        featureName: name,
        resultBodyId: ids.bodyId,
        gate: 'feature'
      };
    }
    case 'edit-fillet':
    case 'remove-face-feature':
      throw new Error(`Unsupported in replay v1: ${edit.op}`);
  }
}

function requireFacePick(fixture: DirectEditFixture) {
  const face = fixture.edit.face;
  if (!face) {
    throw new Error(
      `Fixture "${fixture.name}": a ${fixture.edit.op} needs a recorded face pick.`
    );
  }
  return face;
}
