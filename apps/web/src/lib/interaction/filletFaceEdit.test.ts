import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import {
  toBodyId,
  toEntityId,
  toFeatureId,
  toUserId,
  type BodyRepresentation,
  type FaceGeometry,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  blendRadialDirection,
  canRemoveImportedBlendFace,
  editableFilletFeature,
  importedBlendEditNotice,
  IMPORTED_BLEND_READ_ONLY_NOTICE,
  IMPORTED_BLEND_REMOVABLE_NOTICE,
  newBlendFaceSelections,
  resolveFilletBlendFace
} from './filletFaceEdit';

const point = (x: number, y: number, z: number) => ({ x, y, z });
const featureId = toFeatureId('feature_fillet');
const evolutionLineage =
  'modifier.fillet.face.band-between.primitive.box.face.x-max|primitive.box.face.z-max';

function blendFace(
  topologyId: string,
  center = point(0, 0, 0),
  hash = topologyId.length,
  surfaceType = 'cylinder',
  lineageName = evolutionLineage
): FaceTopology {
  return {
    topologyId,
    hash,
    triangleStart: 0,
    triangleCount: 2,
    reference: {
      kind: 'face',
      producingFeatureId: featureId,
      lineageName,
      currentHash: hash,
      witnessVersion: 1,
      witness: {
        surfaceType,
        perimeter: 20,
        centroid: [center.x, center.y, center.z],
        analytic: {
          kind: 'cylinder',
          radius: 2,
          axis: [0, 0, 1],
          axisFoot: [0, 0, 0]
        },
        closure: { u: 'closed', v: 'open' }
      }
    },
    geometry: {
      surfaceType,
      area: 10,
      center,
      featureType: 'blend',
      blendRadius: 2
    }
  };
}

describe('fillet face editing', () => {
  it('arms only a blend whose lineage resolves to a fillet feature', () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Fillet edit', toUserId('user_fillet_edit')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const result = filletEdges(base, {
      name: 'Corner fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [1],
      size: 2,
      ids: {
        featureId,
        featureNodeId: toEntityId('node_feature_fillet'),
        bodyId: toBodyId('body_fillet'),
        bodyNodeId: toEntityId('node_body_fillet')
      }
    });
    const face = blendFace('blend');
    expect(
      editableFilletFeature(result.document, face, [face])?.featureId
    ).toBe(featureId);
    face.geometry!.featureType = undefined;
    expect(editableFilletFeature(result.document, face, [face])).toBeNull();
  });

  it('rejects fallback and duplicate lineage instead of arming an edit', () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Fillet lineage', toUserId('user_fillet_lineage')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const result = filletEdges(base, {
      name: 'Corner fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [1],
      size: 2,
      ids: {
        featureId,
        featureNodeId: toEntityId('node_feature_fillet_lineage'),
        bodyId: toBodyId('body_fillet_lineage'),
        bodyNodeId: toEntityId('node_body_fillet_lineage')
      }
    });
    const fallback = blendFace(
      'fallback',
      point(0, 0, 0),
      1,
      'torus',
      'modifier.cylinder.face.blend.start'
    );
    expect(
      editableFilletFeature(result.document, fallback, [fallback])
    ).toBeNull();

    const selected = blendFace('selected', point(-5, 0, 0), 2);
    const duplicate = blendFace('duplicate', point(50, 0, 0), 3);
    expect(
      editableFilletFeature(result.document, selected, [selected, duplicate])
    ).toBeNull();
  });

  it('derives cylinder and torus minor-radius directions analytically', () => {
    const cylinder: FaceGeometry = {
      surfaceType: 'cylinder',
      area: 10,
      center: point(0, 0, 0),
      axisStart: point(0, 0, -2),
      axisEnd: point(0, 0, 2)
    };
    expect(
      blendRadialDirection(cylinder, point(4, 0, 1), point(0, 1, 0))
    ).toEqual(point(1, 0, 0));

    const torus: FaceGeometry = {
      surfaceType: 'torus',
      area: 10,
      center: point(0, 0, 0),
      torusCenter: point(0, 0, 0),
      axis: point(0, 0, 1),
      majorRadius: 5
    };
    expect(blendRadialDirection(torus, point(5, 0, 2), point(1, 0, 0))).toEqual(
      point(0, 0, 1)
    );
  });

  it('reselects only by exact evolution identity without using hash or geometry', () => {
    const source = blendFace('source', point(0, 0, 10), 101);
    const moved = blendFace('moved', point(500, 0, -200), 999);
    const other = blendFace(
      'other',
      point(0, 0, 11),
      888,
      'cylinder',
      `${evolutionLineage}.other`
    );
    expect(resolveFilletBlendFace([other, moved], source)).toBe(moved);
  });

  it('fails closed when one evolution identity appears on multiple faces', () => {
    const source = blendFace('source', point(0, 0, 0), 101);
    const left = blendFace('left', point(-1, 0, 0), 202);
    const farAway = blendFace('far-away', point(100, 0, 0), 303);
    expect(resolveFilletBlendFace([left, farAway], source)).toBeNull();
  });

  it('diffs only genuinely new preview blend hashes across all bodies', () => {
    const existing = blendFace('existing', point(0, 0, 0), 40);
    const created = blendFace('created', point(1, 0, 0), 41);
    const base = createProjectDocument(
      'Blend diff',
      toUserId('user_blend_diff')
    );
    const baseBody = {
      bodyId: toBodyId('body_base'),
      consumed: false,
      topology: { faces: [existing], edges: [], vertices: [] }
    } as unknown as BodyRepresentation;
    base.derived.bodyRepresentations[baseBody.bodyId] = baseBody;
    const previewBody = {
      ...baseBody,
      bodyId: toBodyId('body_preview'),
      topology: { faces: [existing, created], edges: [], vertices: [] }
    } as BodyRepresentation;
    const derived = {
      ...base.derived,
      bodyRepresentations: { [previewBody.bodyId]: previewBody }
    } satisfies ProjectDocument['derived'];

    expect(newBlendFaceSelections(base, derived)).toEqual([
      expect.objectContaining({ bodyId: previewBody.bodyId, hash: 41 })
    ]);
  });

  it('shows imported removal only when every remaining face is planar', () => {
    const selected = blendFace('selected');
    const plane = {
      ...blendFace('plane'),
      geometry: {
        surfaceType: 'plane',
        area: 10,
        center: point(0, 0, 0)
      }
    };
    const body = {
      source: 'imported-step',
      topology: { faces: [selected, plane], edges: [], vertices: [] }
    } as unknown as BodyRepresentation;
    expect(canRemoveImportedBlendFace(body, selected)).toBe(true);
    body.topology!.faces.push(blendFace('other-blend'));
    expect(canRemoveImportedBlendFace(body, selected)).toBe(false);
  });

  it('explains the validated imported removal path without claiming history', () => {
    const selected = blendFace('selected');
    const plane = {
      ...blendFace('plane'),
      geometry: {
        surfaceType: 'plane',
        area: 10,
        center: point(0, 0, 0)
      }
    };
    const body = {
      source: 'imported-step',
      topology: { faces: [selected, plane], edges: [], vertices: [] }
    } as unknown as BodyRepresentation;

    expect(importedBlendEditNotice(body, selected)).toBe(
      IMPORTED_BLEND_REMOVABLE_NOTICE
    );
    expect(importedBlendEditNotice(body, selected)).toMatch(/Undo restores/i);
  });

  it('fails closed with a recovery path when imported removal is unproven', () => {
    const selected = blendFace('selected');
    const body = {
      source: 'imported-step',
      topology: {
        faces: [selected, blendFace('other-blend')],
        edges: [],
        vertices: []
      }
    } as unknown as BodyRepresentation;

    expect(importedBlendEditNotice(body, selected)).toBe(
      IMPORTED_BLEND_READ_ONLY_NOTICE
    );
    expect(importedBlendEditNotice(body, selected)).toMatch(
      /recreate the detail as a native Fillet/i
    );
  });
});
