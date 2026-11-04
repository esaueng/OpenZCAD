import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  directEditBody,
  filletEdges
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';

export function unionEndFace(body: BodyRepresentation) {
  const face = body.topology?.faces.find(
    (candidate) =>
      candidate.reference?.lineageName ===
      'boolean.face.operand.1.primitive.box.face.x-max'
  );
  if (!face) throw new Error('The union end face lost its operand role.');
  return face;
}

/** Authored native geometry with an R5 junction blend and a later height edit. */
export async function filletedUnion(adapter: ExactKernelAdapter) {
  const box = addPrimitiveFeature(
    createProjectDocument('Filleted union', toUserId('user_filleted_union')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 26 }
    }
  );
  const cylinder = addPrimitiveFeature(box, {
    name: 'Cylinder',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 35 }
  });
  const joined = booleanBodies(cylinder, {
    name: 'Union',
    operation: 'union',
    targetBodyIds: [cylinder.bodyOrder[1]!, box.bodyOrder[0]!]
  });
  const base = await adapter.syncDocument(joined.document);
  if (base.warnings.length) throw new Error(base.warnings.join('\n'));
  const source = base.bodyRepresentations[joined.bodyId]!;
  const edges = source.topology!.edges.filter((edge) => {
    const names = (edge.adjacentFaceHashes ?? []).map(
      (hash) =>
        source.topology!.faces.find((face) => face.hash === hash)?.reference
          ?.lineageName ?? ''
    );
    // The cylinder-to-box junction plus the two top edges that meet it.
    return (
      (names.some((name) => name.endsWith('primitive.cylinder.face.wall')) &&
        names.some((name) =>
          /primitive\.box\.face\.(?:[xy]-min|z-max)$/.test(name)
        )) ||
      (names.some((name) => name.endsWith('primitive.box.face.z-max')) &&
        names.some((name) => /primitive\.box\.face\.[xy]-min$/.test(name)))
    );
  });
  if (edges.length !== 5) throw new Error('Expected the five junction edges.');
  const rounded = filletEdges(joined.document, {
    name: 'Junction fillet',
    targetBodyId: joined.bodyId,
    edgeHashes: edges.map((edge) => edge.hash),
    edgeReferences: edges.flatMap((edge) =>
      edge.reference ? [edge.reference] : []
    ),
    size: 5
  });
  const derived = await adapter.syncDocument(rounded.document);
  if (derived.warnings.length) throw new Error(derived.warnings.join('\n'));
  const bodyId = rounded.bodyId;
  const top = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
    (face) =>
      face.reference?.lineageName ===
      'boolean.face.operand.1.primitive.box.face.z-max'
  )!;
  // A subsequent local height edit exercises replay through existing edits.
  const edited = directEditBody(rounded.document, {
    name: 'Offset top',
    targetBodyId: bodyId,
    operation: {
      kind: 'offset-face',
      faceHash: top.hash,
      faceReference: top.reference,
      sourceSurfaceType: 'plane',
      sourceArea: top.geometry!.area,
      sourceCenter: top.geometry!.center,
      sourceNormal: top.geometry!.normal!,
      offset: -6.28
    }
  });
  const final = await adapter.syncDocument(edited.document);
  if (final.warnings.length) throw new Error(final.warnings.join('\n'));
  edited.document.derived = final;
  return {
    document: edited.document,
    bodyId,
    body: final.bodyRepresentations[bodyId]!
  };
}

/** A completed public history loaded cold into the caller's adapter. */
export async function longFilletedUnion(adapter: ExactKernelAdapter) {
  const authoring = await createExactKernelAdapter();
  const model = await filletedUnion(authoring).finally(() =>
    authoring.dispose()
  );
  let document = model.document;
  const top = model.body.topology!.faces.find(
    (f) =>
      f.reference?.lineageName ===
      'boolean.face.operand.1.primitive.box.face.z-max'
  )!;
  for (let index = 0; index < 20; index += 1) {
    document = directEditBody(document, {
      name: `Height adjustment ${index + 1}`,
      targetBodyId: model.bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: top.hash,
        faceReference: top.reference,
        sourceSurfaceType: 'plane',
        sourceArea: top.geometry!.area,
        sourceCenter: top.geometry!.center,
        sourceNormal: top.geometry!.normal!,
        offset: index % 2 === 0 ? 0.4 : -0.3
      }
    }).document;
  }
  const derived = await adapter.syncDocument(document);
  return {
    ...model,
    document: { ...document, derived },
    body: derived.bodyRepresentations[model.bodyId]!
  };
}
