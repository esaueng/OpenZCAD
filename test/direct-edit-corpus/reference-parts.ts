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
  FeatureId,
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
export const BASE_CHAMFER = 1;

export type PartName = 'A' | 'frustum' | 'B' | 'C' | 'D';

interface BodyDocument {
  document: ProjectDocument;
  bodyId: BodyId;
  fittedJunction?: FeatureId;
}

export interface ReferencePart extends BodyDocument {
  body: BodyRepresentation;
  baseSection?: number;
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
  checkConstructionAccuracy(input, derived.featureWarnings ?? []);
  return { ...input, body };
}

// The two fitted corner patches belong to one source fillet. Subsequent
// commands must neither add an approximation nor lose this disclosure.
export function checkConstructionAccuracy(
  part: BodyDocument,
  warnings: FeatureWarning[]
): void {
  const fitted = warnings.filter((warning) =>
    /approximate/i.test(warning.message)
  );
  const expected =
    'Feature "Corner junction": This fillet is approximate: its blend surface is a NURBS fit within modeling tolerance, not an exact fillet surface. Volume, measurements and STEP export use that approximate surface.';
  if (
    part.fittedJunction
      ? fitted.length !== 1 ||
        fitted[0]!.featureId !== part.fittedJunction ||
        fitted[0]!.kind !== 'advisory' ||
        fitted[0]!.message !== expected
      : fitted.length !== 0
  ) {
    throw new Error(
      `Unexpected approximation warnings: ${fitted.map((w) => w.message).join('; ')}`
    );
  }
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
  kind: 'fillet' | 'chamfer' | 'fitted junction' = 'fillet'
): Promise<ReferencePart> {
  if (selected.length === 0) throw new Error('No reference edges selected.');
  const modify = kind === 'chamfer' ? chamferEdges : filletEdges;
  const references = selected.flatMap((edge) =>
    edge.reference ? [edge.reference] : []
  );
  const result = modify(part.document, {
    name: {
      fillet: 'Blend edges',
      chamfer: 'Chamfer caps',
      'fitted junction': 'Corner junction'
    }[kind],
    targetBodyId: part.bodyId,
    edgeHashes: selected.map((edge) => edge.hash),
    ...(references.length === selected.length
      ? { edgeReferences: references }
      : {}),
    size
  });
  return build(session, {
    ...result,
    fittedJunction:
      kind === 'fitted junction'
        ? result.document.featureOrder.at(-1)!
        : part.fittedJunction
  });
}

/** The post shares the plate's lower corner and projects above its top. */
async function cornerPost(
  session: Session,
  plate: ProjectDocument,
  depth: number,
  height: number,
  radius: number,
  root: number,
  rim: number
): Promise<ReferencePart> {
  const document = addPrimitiveFeature(plate, {
    name: 'Corner post',
    primitiveKind: 'cylinder',
    dimensions: { radius, height }
  });
  const united = await build(
    session,
    booleanBodies(document, {
      name: 'Corner union',
      operation: 'union',
      targetBodyIds: document.bodyOrder
    })
  );
  // Edges at the intersection of the two near walls and the top shoulder.
  const at = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const junction = edges(united).filter((edge) => {
    const { x, y, z } = edgeCenter(edge);
    if (edge.curve?.circle) return at(edge.curve.circle.center.z, depth);
    return (
      edge.curve?.type === 'LINE' &&
      ((at(z, depth) && (at(x, 0) || at(y, 0))) ||
        (at(z, depth / 2) &&
          ((at(x, radius) && at(y, 0)) || (at(x, 0) && at(y, radius)))))
    );
  });
  if (junction.length !== 5)
    throw new Error('Expected five corner-post junction edges.');
  const shoulder = await blend(
    session,
    united,
    junction,
    root,
    'fitted junction'
  );
  const crown = edges(shoulder).filter(
    (edge) => edge.curve?.circle && at(edge.curve.circle.center.z, height)
  );
  if (crown.length !== 4)
    throw new Error('Expected four arcs on the post cap.');
  const capped = await blend(session, shoulder, crown, rim);
  const farCorner = edges(capped).filter((edge) => {
    if (edge.curve?.type !== 'LINE') return false;
    const { x, y, z } = edgeCenter(edge);
    return (
      (at(x, BOX.width) && at(y, BOX.height)) ||
      (at(z, depth) && (at(x, BOX.width) || at(y, BOX.height)))
    );
  });
  if (farCorner.length !== 3)
    throw new Error('Expected three far-corner edges.');
  const rounded = await blend(session, capped, farCorner, rim);
  const underside = edges(rounded).filter((edge) => at(edgeCenter(edge).z, 0));
  if (underside.length !== 12)
    throw new Error('Expected twelve segments on the base perimeter.');
  const baseFaces = rounded.body.topology!.faces.filter(
    (f) => f.geometry?.normal?.z === -1
  );
  if (baseFaces.length !== 1)
    throw new Error('Expected one planar base before chamfering.');
  return {
    ...(await blend(session, rounded, underside, BASE_CHAMFER, 'chamfer')),
    baseSection: baseFaces[0]!.geometry!.area
  };
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
  if (name === 'A')
    return cornerPost(
      session,
      document,
      depth,
      postHeight,
      postRadius,
      root,
      rim
    );
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

  // The truncated Cone primitive gives the frustum control an analytic conical wall and a
  // planar cap. Boss C uses the same placement with a straight cylinder.
  const source = name === 'frustum' ? TAPER : { radius: postRadius };
  const withPost = addPrimitiveFeature(document, {
    name: 'Boss',
    primitiveKind: name === 'frustum' ? 'cone' : 'cylinder',
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
