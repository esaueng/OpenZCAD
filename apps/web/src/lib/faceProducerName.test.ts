import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  numberedBodyName
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FaceTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  faceNamerFor,
  faceProducingFeature,
  producedFaceName,
  producedFaceNames
} from './faceProducerName';

const user = toUserId('user_face_names');

function box(document: ProjectDocument, numbered = true): ProjectDocument {
  return addPrimitiveFeature(document, {
    name: 'Box',
    ...(numbered ? { bodyName: numberedBodyName(document, 'Box') } : {}),
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 10 }
  });
}

function featureOfBody(document: ProjectDocument, bodyId: BodyId) {
  return Object.values(document.nodes).find(
    (node) => node.kind === 'feature' && node.bodyId === bodyId
  ) as { featureId: FeatureId; name: string };
}

/** A planar face carrying a current lineage reference. */
function face(
  hash: number,
  producingFeatureId: FeatureId,
  lineageName: string,
  normal = { x: 0, y: 0, z: 1 }
): FaceTopology {
  return {
    topologyId: `face:${hash}`,
    hash,
    triangleStart: 0,
    triangleCount: 2,
    geometry: {
      surfaceType: 'plane',
      area: 1,
      center: { x: 0, y: 0, z: 0 },
      normal
    },
    reference: {
      kind: 'face',
      producingFeatureId,
      lineageName,
      currentHash: hash,
      witnessVersion: 1,
      witness: {} as never
    }
  };
}

function bodyWith(faces: FaceTopology[]): BodyRepresentation {
  return { topology: { faces, edges: [] } } as unknown as BodyRepresentation;
}

function plateWithBoss(operation: 'add' | 'cut') {
  let document = box(createProjectDocument('Boss', user));
  const plate = document.bodyOrder[0]!;
  const sketch = addSketchFeature(document, {
    name: 'Sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
    objects: [
      { objectKind: 'rectangle', width: 4, height: 4, centerX: 5, centerY: 5 }
    ]
  });
  const extruded = extrudeSketch(sketch.document, {
    name: 'Boss',
    bodyName: numberedBodyName(sketch.document, 'Boss'),
    sketchId: sketch.sketchId,
    distance: operation === 'add' ? 4 : -4,
    operation,
    targetBodyId: plate
  });
  document = extruded.document;
  return { document, plate, result: extruded.bodyId };
}

describe('faces named by the feature that made them', () => {
  it('reads a primitive face as its numbered body', () => {
    const document = box(box(createProjectDocument('Boxes', user)));
    const second = featureOfBody(document, document.bodyOrder[1]!);
    const top = face(1, second.featureId, 'primitive.box.face.z-max');
    expect(producedFaceName(document, bodyWith([top]), top)).toBe(
      'Box 2 · top'
    );
  });

  it('splits an add extrude into the target it kept and the boss it grew', () => {
    const { document, result } = plateWithBoss('add');
    const boss = featureOfBody(document, result);
    const kept = face(
      1,
      boss.featureId,
      'boolean.face.target.primitive.box.face.z-max'
    );
    const cap = face(
      2,
      boss.featureId,
      'boolean.face.tool.sweep.face.cap.end.region.r.o.0'
    );
    const wall = face(
      3,
      boss.featureId,
      'boolean.face.tool.sweep.face.side.region.r.o.0',
      { x: 0, y: -1, z: 0 }
    );
    const body = bodyWith([kept, cap, wall]);
    expect(
      producedFaceNames(document, body, [kept, cap, wall]).map(
        (name) => name?.name
      )
    ).toEqual(['Box 1 · top', 'Boss · top', 'Boss · front']);
  });

  it('follows a fillet copy of a box face back to the box', () => {
    const base = box(box(createProjectDocument('Fillet', user)));
    const target = base.bodyOrder[1]!;
    const { document } = filletEdges(base, {
      name: 'Fillet',
      targetBodyId: target,
      edgeHashes: [9],
      size: 1
    });
    const fillet = featureOfBody(document, document.bodyOrder.at(-1)!);
    const side = face(1, fillet.featureId, 'modifier.box.face.x-max', {
      x: 1,
      y: 0,
      z: 0
    });
    const blend = face(2, fillet.featureId, 'modifier.box.face.blend.0');
    expect(faceProducingFeature(document, side)?.name).toBe('Box');
    expect(producedFaceName(document, bodyWith([side]), side)).toBe(
      'Box 2 · right'
    );
    // A blend is the fillet's own face.
    expect(faceProducingFeature(document, blend)?.name).toBe('Fillet');
  });

  it('reads a body still named "<feature> Body" as its feature', () => {
    const document = box(createProjectDocument('Legacy', user), false);
    const feature = featureOfBody(document, document.bodyOrder[0]!);
    const top = face(1, feature.featureId, 'primitive.box.face.z-max');
    expect(producedFaceName(document, bodyWith([top]), top)).toBe('Box · top');
  });

  it('says nothing for a face whose lineage cannot place it', () => {
    const document = box(createProjectDocument('Unnamed', user));
    const feature = featureOfBody(document, document.bodyOrder[0]!);
    const stale = {
      ...face(1, feature.featureId, 'primitive.box.face.z-max'),
      hash: 7
    };
    const foreign = face(
      2,
      'feature_gone' as FeatureId,
      'primitive.box.face.z-max'
    );
    const bare = { ...face(3, feature.featureId, 'x') };
    delete (bare as { reference?: unknown }).reference;
    for (const candidate of [stale, foreign, bare]) {
      expect(
        producedFaceName(document, bodyWith([candidate]), candidate)
      ).toBeNull();
    }
  });

  it('names a body once per document, however often the list renders', () => {
    const document = box(createProjectDocument('Cached', user));
    const feature = featureOfBody(document, document.bodyOrder[0]!);
    const faces = [face(1, feature.featureId, 'primitive.box.face.z-max')];
    const body = bodyWith(faces);
    const namer = faceNamerFor(document);
    const first = namer(body, faces);
    expect(first.map((name) => name?.name)).toEqual(['Box 1 · top']);
    expect(namer(body, faces)).toBe(first);
    // New topology is named afresh.
    expect(namer(body, [...faces])).not.toBe(first);
  });
});
