import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type FaceTopologyReferenceV5
} from '@openzcad/shared';

import {
  AI_CAD_OPERATION_CAPABILITIES,
  CAD_PATCH_JSON_SCHEMA,
  type CadDocumentDigest,
  createCadDocumentDigest,
  describeCadPatchOperation,
  parseCadPatchProposal
} from './index';

const faceReference: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId:
    'feature_source' as FaceTopologyReferenceV5['producingFeatureId'],
  lineageName: 'feature_source/face:top',
  currentHash: 101,
  witnessVersion: 1,
  witness: {
    surfaceType: 'plane',
    perimeter: 4000,
    centroid: [0, 0, 1000],
    analytic: { kind: 'plane', normal: [0, 0, 1000], offset: 1000 },
    closure: { u: 'open', v: 'open' }
  }
};

const frame = {
  origin: { x: 0, y: 0, z: 10 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 }
};

const facePlane = {
  type: 'face' as const,
  bodyId: 'body_source',
  faceHash: 101,
  faceReference,
  sourceArea: 100,
  sourceCenter: { x: 0, y: 0, z: 10 },
  sourceNormal: { x: 0, y: 0, z: 1 },
  frame
};

const circle = {
  objectKind: 'circle' as const,
  radius: 4,
  centerX: 0,
  centerY: 0
};

function proposal(operations: unknown[]) {
  return {
    proposalId: 'proposal_modeling',
    summary: 'Use deterministic modeling operations.',
    assumptions: [],
    operations
  };
}

function currentDigest(): CadDocumentDigest {
  return {
    schemaVersion: 5,
    projectId: 'project_1',
    name: 'Fixture',
    units: 'mm',
    version: 7,
    parameters: [],
    features: [],
    bodies: [
      {
        bodyId: 'body_source',
        name: 'Source',
        consumed: false,
        volume: 1000,
        bbox: {
          min: { x: -5, y: -5, z: 0 },
          max: { x: 5, y: 5, z: 10 }
        },
        topology: {
          faceCount: 1,
          edgeCount: 0,
          modifierEdgeCount: 0,
          faceInventoryComplete: true,
          edgeInventoryComplete: true,
          faces: [
            {
              topologyId: 'face:top',
              hash: 101,
              reference: faceReference,
              snapshot: {
                surfaceType: 'plane',
                area: 100,
                center: { x: 0, y: 0, z: 10 },
                normal: { x: 0, y: 0, z: 1 }
              },
              attachmentFrame: frame
            }
          ],
          edges: []
        }
      }
    ],
    warnings: []
  };
}

describe('AI deterministic modeling operation contracts', () => {
  it('publishes exact face references, snapshots, and deterministic attachment frames', () => {
    const document = createProjectDocument(
      'Digest fixture',
      toUserId('user_ai')
    );
    const bodyId = toBodyId('body_source');
    document.bodyOrder.push(bodyId);
    document.derived.bodyRepresentations[bodyId] = {
      bodyId,
      name: 'Source',
      source: 'primitive',
      mesh: { kind: 'mesh', vertices: Float32Array.from([]), indices: Uint32Array.from([]) },
      faceCount: 1,
      color: '#888888',
      exportableStep: true,
      consumed: false,
      volume: 1000,
      bbox: {
        min: { x: -5, y: -5, z: 0 },
        max: { x: 5, y: 5, z: 10 }
      },
      topology: {
        faces: [
          {
            topologyId: 'face:top',
            hash: 101,
            reference: faceReference,
            triangleStart: 0,
            triangleCount: 0,
            geometry: {
              surfaceType: 'plane',
              area: 100.123456,
              center: { x: 0, y: 0, z: 10 },
              normal: { x: 0, y: 0, z: 1 }
            }
          }
        ],
        edges: []
      }
    };

    const face =
      createCadDocumentDigest(document).bodies?.[0]?.topology?.faces[0];
    expect(face?.reference).toEqual(faceReference);
    expect(face?.snapshot?.area).toBe(100.123456);
    expect(face?.area).toBe(100.1235);
    expect(face?.attachmentFrame).toEqual(frame);
  });

  it('keeps JSON-schema operation kinds in parity with the runtime validator', () => {
    const operationSchemas =
      CAD_PATCH_JSON_SCHEMA.properties.operations.items.anyOf;
    const schemaKinds = operationSchemas.map(
      (schema) => schema.properties.kind.const
    );
    expect(schemaKinds).toEqual(
      expect.arrayContaining([
        'add_direct_edit',
        'add_face_sketch',
        'add_multi_profile_extrude',
        'add_mirror',
        'add_shell',
        'add_solid_offset'
      ])
    );

    const operations = [
      {
        kind: 'add_direct_edit',
        name: 'Offset top',
        targetBodyId: 'body_source',
        operation: {
          kind: 'offset-face',
          faceHash: 101,
          faceReference,
          sourceSurfaceType: 'plane',
          sourceArea: 100,
          sourceCenter: { x: 0, y: 0, z: 10 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 2
        }
      },
      {
        kind: 'add_face_sketch',
        name: 'Top profile',
        localId: 'top_profile',
        planeRef: facePlane,
        objects: [circle]
      },
      {
        kind: 'add_multi_profile_extrude',
        name: 'Two bosses',
        localId: 'bosses',
        sketchId: '$top_profile',
        distance: 5,
        samplePoints: [
          { x: -4, y: 0 },
          { x: 4, y: 0 }
        ]
      },
      {
        kind: 'add_mirror',
        name: 'Mirrored',
        localId: 'mirrored',
        targetBodyId: '$bosses',
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        }
      },
      {
        kind: 'add_shell',
        name: 'Open shell',
        localId: 'shell',
        targetBodyId: 'body_source',
        openingFaceHashes: [101],
        openingFaceReferences: [faceReference],
        thickness: 1
      },
      {
        kind: 'add_solid_offset',
        name: 'Clearance',
        localId: 'clearance',
        targetBodyId: '$mirrored',
        distance: 0.25
      }
    ];

    expect(
      parseCadPatchProposal(proposal(operations)).operations.map(
        (operation) => operation.kind
      )
    ).toEqual(operations.map((operation) => operation.kind));
  });

  it('accepts exact current face context and rejects a stale lineage reference', () => {
    const operation = {
      kind: 'add_face_sketch',
      name: 'Top profile',
      localId: null,
      planeRef: facePlane,
      objects: [circle]
    };
    expect(
      parseCadPatchProposal(proposal([operation]), currentDigest()).operations
    ).toHaveLength(1);

    const staleReference = {
      ...faceReference,
      lineageName: 'feature_source/face:deleted'
    };
    expect(() =>
      parseCadPatchProposal(
        proposal([
          {
            ...operation,
            planeRef: { ...facePlane, faceReference: staleReference }
          }
        ]),
        currentDigest()
      )
    ).toThrow(/stale or unavailable face reference/);
  });

  it('allows ordered body aliases only for operations that do not need topology', () => {
    const primitive = {
      kind: 'add_primitive',
      name: 'Seed',
      localId: 'seed',
      primitiveKind: 'box',
      dimensions: {
        width: 10,
        height: 10,
        depth: 10,
        radius: null,
        bottomRadius: null,
        topRadius: null,
        majorRadius: null,
        minorRadius: null
      }
    };
    expect(
      parseCadPatchProposal(
        proposal([
          primitive,
          {
            kind: 'add_mirror',
            name: 'Copy',
            localId: 'copy',
            targetBodyId: '$seed',
            plane: {
              origin: { x: 0, y: 0, z: 0 },
              normal: { x: 1, y: 0, z: 0 }
            }
          },
          {
            kind: 'add_solid_offset',
            name: 'Offset copy',
            localId: null,
            targetBodyId: '$copy',
            distance: 1
          }
        ])
      ).operations
    ).toHaveLength(3);

    expect(() =>
      parseCadPatchProposal(
        proposal([
          primitive,
          {
            kind: 'add_shell',
            name: 'Unsafe shell',
            localId: null,
            targetBodyId: '$seed',
            openingFaceHashes: [101],
            openingFaceReferences: [faceReference],
            thickness: 1
          }
        ])
      )
    ).toThrow(/referenced topology does not exist yet/);
  });

  it('rejects hash-only and mismatched shell references', () => {
    expect(() =>
      parseCadPatchProposal(
        proposal([
          {
            kind: 'add_shell',
            name: 'Unsafe shell',
            localId: null,
            targetBodyId: 'body_source',
            openingFaceHashes: [101],
            openingFaceReferences: [],
            thickness: 1
          }
        ])
      )
    ).toThrow(/Invalid add_shell/);
    expect(() =>
      parseCadPatchProposal(
        proposal([
          {
            kind: 'add_shell',
            name: 'Wrong face',
            localId: null,
            targetBodyId: 'body_source',
            openingFaceHashes: [999],
            openingFaceReferences: [faceReference],
            thickness: 1
          }
        ])
      )
    ).toThrow(/Invalid add_shell/);
  });

  it('labels unsupported recognized-import editing and produces readable summaries', () => {
    expect(
      AI_CAD_OPERATION_CAPABILITIES.recognized_imported_feature.enabled
    ).toBe(false);
    expect(
      AI_CAD_OPERATION_CAPABILITIES.recognized_imported_feature.reason
    ).toMatch(/stable command contract/);
    expect(() =>
      parseCadPatchProposal(
        proposal([
          {
            kind: 'recognized_imported_feature',
            name: 'Resize imported hole'
          }
        ])
      )
    ).toThrow(/disabled.*stable command contract/i);
    const parsed = parseCadPatchProposal(
      proposal([
        {
          kind: 'add_solid_offset',
          name: 'Clearance',
          localId: null,
          targetBodyId: 'body_source',
          distance: 0.5
        }
      ])
    );
    expect(describeCadPatchOperation(parsed.operations[0]!)).toMatch(
      /Offset body body_source outward by 0.5/
    );
  });
});
