import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  BodyRepresentation,
  EdgeTopology,
  FeatureWarning,
  ProjectDocument
} from '@openzcad/shared';

import { refusal, sync, type Session } from '../support/combination-matrix';
import { validatedFeatureRejection } from '../../apps/web/src/lib/featureValidation';
import { edgeCenter } from './resolve';

export const BOX = { width: 40, height: 36, depth: 12 };
export const POST = { radius: 8, height: 24 };
export const TAPER = { bottomRadius: 9, topRadius: 5, height: 24 };
export const RIM = 1.5;
export const ROOT = 2;
export const EMBED = 2;

export type PartName = 'A' | 'B' | 'C' | 'D';

interface BodyDocument {
  document: ProjectDocument;
  bodyId: BodyId;
}

export interface ReferencePart extends BodyDocument {
  body: BodyRepresentation;
}

class ReferenceBuildRefusal extends Error {
  constructor(
    message: string,
    readonly kernelRefusal: NonNullable<FeatureWarning['kernelRefusal']>
  ) {
    super(message);
  }
}

async function build(
  session: Session,
  input: BodyDocument
): Promise<ReferencePart> {
  const derived = await sync(session, input.document, input.bodyId);
  const failure = refusal(derived, 'reference construction');
  const body = derived.bodyRepresentations[input.bodyId];
  const blocked = derived.featureWarnings?.find(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
  if (blocked?.kernelRefusal) {
    const diagnostic = validatedFeatureRejection({
      featureName: blocked.featureName,
      featureId: blocked.featureId,
      warnings: derived.warnings,
      featureWarnings: derived.featureWarnings,
      bodyPresent: body !== undefined,
      documentMoved: false
    });
    throw new ReferenceBuildRefusal(
      diagnostic?.message ?? blocked.message,
      blocked.kernelRefusal
    );
  }
  if (failure || !body?.exportableStep || !body.topology) {
    throw new Error(
      failure?.evidence ??
        'Reference construction did not produce an exact body.'
    );
  }
  if (
    derived.featureWarnings?.some((warning) =>
      /approximate/i.test(warning.message)
    )
  ) {
    throw new Error(
      `Reference construction is approximate: ${derived.warnings.join(' ')}`
    );
  }
  return { ...input, body };
}

function edges(part: ReferencePart): EdgeTopology[] {
  return part.body.topology!.edges.filter(
    (edge) => edge.displayRole !== 'seam'
  );
}

/** Independent feature route for B when the selected corner grows alone. */
export async function unequalCorner(
  session: Session,
  radius: number
): Promise<ReferencePart> {
  const box = await referencePart(session, 'B', { rim: 0 });
  const corner = edges(box).filter((edge) => {
    const { x, y } = edgeCenter(edge);
    return edge.curve?.type === 'LINE' && x === 0 && y === 0;
  });
  if (corner.length !== 1)
    throw new Error('The wide corner has no unique vertical edge.');
  const wide = await blend(session, box, corner, radius);
  const other = edges(wide).filter((edge) => {
    const { x, y, z } = edgeCenter(edge);
    return (
      edge.curve?.type === 'LINE' &&
      (z === 0 ||
        z === BOX.depth ||
        ((x === 0 || x === BOX.width) && (y === 0 || y === BOX.height)))
    );
  });
  if (other.length !== 11)
    throw new Error(`Expected 11 narrow edges, found ${other.length}.`);
  return blend(session, wide, other, RIM);
}

async function blend(
  session: Session,
  part: ReferencePart,
  selected: EdgeTopology[],
  size: number,
  kind: 'fillet' | 'chamfer' = 'fillet'
): Promise<ReferencePart> {
  if (selected.length === 0) throw new Error('No reference edges selected.');
  const modify = kind === 'fillet' ? filletEdges : chamferEdges;
  const references = selected.flatMap((edge) =>
    edge.reference ? [edge.reference] : []
  );
  return build(
    session,
    modify(part.document, {
      name: kind === 'fillet' ? 'Blend edges' : 'Chamfer caps',
      targetBodyId: part.bodyId,
      edgeHashes: selected.map((edge) => edge.hash),
      ...(references.length === selected.length
        ? { edgeReferences: references }
        : {}),
      size
    })
  );
}

export async function referencePart(
  session: Session,
  name: PartName,
  {
    depth = BOX.depth,
    postHeight = POST.height,
    postRadius = POST.radius,
    embed = EMBED,
    rim = RIM,
    root = ROOT
  } = {}
): Promise<ReferencePart> {
  const document = addPrimitiveFeature(
    createProjectDocument(
      `CAD QA part ${name}`,
      toUserId('user_direct_edit_corpus')
    ),
    name === 'D'
      ? {
          name: 'Cylinder',
          primitiveKind: 'cylinder',
          dimensions: { radius: postRadius, height: postHeight }
        }
      : { name: 'Plate', primitiveKind: 'box', dimensions: { ...BOX, depth } }
  );
  const bodyId = document.bodyOrder[0]!;
  if (name === 'B' || name === 'D') {
    const base = await build(session, { document, bodyId });
    return rim === 0
      ? base
      : blend(
          session,
          base,
          edges(base),
          rim,
          name === 'D' ? 'chamfer' : 'fillet'
        );
  }

  // The truncated Cone primitive gives A an analytic conical wall and a
  // planar cap. Boss C uses the same placement with a straight cylinder.
  const source = name === 'A' ? TAPER : { radius: postRadius };
  const withPost = addPrimitiveFeature(document, {
    name: 'Boss',
    primitiveKind: name === 'A' ? 'cone' : 'cylinder',
    dimensions: { ...source, height: postHeight }
  });
  const postId = withPost.bodyOrder[1]!;
  const placed = transformBody(withPost, {
    name: 'Place boss',
    targetBodyId: postId,
    translation: { x: BOX.width / 2, y: BOX.height / 2, z: depth - embed }
  });
  const united = await build(
    session,
    booleanBodies(placed.document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [bodyId, postId]
    })
  );
  const seam = edges(united).filter((edge) => {
    const circle = edge.curve?.circle;
    return circle && Math.abs(circle.center.z - depth) < 1e-9;
  });
  const withRoot =
    root === 0 ? united : await blend(session, united, seam, root);
  if (name === 'C') return withRoot;

  // The root fillet has tangent boundaries. The original sharp edges left
  // for the second fillet are the box's lines and the boss's top rim.
  const remaining = edges(withRoot).filter(
    (edge) =>
      edge.curve?.type === 'LINE' ||
      (edge.curve?.circle &&
        Math.abs(edgeCenter(edge).z - (depth - EMBED + postHeight)) < 1e-9)
  );
  return blend(session, withRoot, remaining, RIM);
}
