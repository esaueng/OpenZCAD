import { describe, expect, it } from 'vitest';
import {
  parseCadPatchProposal,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
import { createAutoParameterizeProposal } from '@openzcad/ai-contracts/auto-parameterize';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  importStepBody,
  listFeaturesInOrder,
  listParameters
} from '@openzcad/document-core';
import {
  toUserId,
  type FaceTopologyReferenceV5,
  type ProjectDocument
} from '@openzcad/shared';

const noSelection: CadSelectionContext = {
  featureIds: [],
  bodyIds: [],
  topologies: []
};

function nativeDocument(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Native literals', toUserId('user_auto'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Mount Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 8 }
    })
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Bolt Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'circle',
          radius: '3',
          centerX: 10,
          centerY: 0
        }
      ]
    })
  );
  return manager.document;
}

describe('assistant auto-parameterization', () => {
  it('binds native feature and safe sketch literals in one replayable patch', () => {
    const document = nativeDocument();
    const proposal = createAutoParameterizeProposal(document, noSelection);

    expect(proposal?.preserveGeometry).toBe(true);
    expect(
      proposal?.operations.filter(
        (operation) => operation.kind === 'set_parameter'
      )
    ).toHaveLength(5);
    expect(proposal?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'set_feature_dimension',
          field: 'width',
          value: 'mount_block_width'
        }),
        expect.objectContaining({
          kind: 'set_sketch_dimension',
          field: 'radius',
          value: 'bolt_profile_circle_1_radius'
        }),
        expect.objectContaining({
          kind: 'set_sketch_dimension',
          field: 'centerX',
          value: 'bolt_profile_circle_1_center_x'
        })
      ])
    );

    const parsed = parseCadPatchProposal(structuredClone(proposal));
    const applied = new CommandManager(document).runTransaction(
      'Auto-parameterize',
      commandsForCadPatch(document, parsed)
    );
    expect(listParameters(applied).map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining([
        'mount_block_width',
        'mount_block_height',
        'mount_block_depth',
        'bolt_profile_circle_1_radius',
        'bolt_profile_circle_1_center_x'
      ])
    );
    const primitive = listFeaturesInOrder(applied).find(
      (feature) => feature.name === 'Mount Block'
    )!;
    expect(primitive.data).toMatchObject({
      dimensions: {
        width: 'mount_block_width',
        height: 'mount_block_height',
        depth: 'mount_block_depth'
      }
    });
    const sketchFeature = listFeaturesInOrder(applied).find(
      (feature) => feature.name === 'Bolt Profile'
    )!;
    if (sketchFeature.data.featureKind !== 'sketch') {
      throw new Error('expected sketch feature');
    }
    const sketch = findSketch(applied, sketchFeature.data.sketchId)!;
    const object = applied.nodes[sketch.objectIds[0]!]!;
    expect(object).toMatchObject({
      kind: 'sketch-object',
      data: {
        radius: 'bolt_profile_circle_1_radius',
        centerX: 'bolt_profile_circle_1_center_x',
        centerY: 0
      }
    });
  });

  it('limits a selected body to its own history branch', () => {
    const manager = new CommandManager(
      createProjectDocument('Two bodies', toUserId('user_auto_scope'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Selected Plate',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 20, depth: 4 }
      })
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Other Plate',
        primitiveKind: 'box',
        dimensions: { width: 90, height: 80, depth: 7 }
      })
    );
    const selectedBodyId = manager.document.bodyOrder[0]!;
    const selectedFeatureId = manager.document.featureOrder[0]!;
    const otherFeatureId = manager.document.featureOrder[1]!;

    const proposal = createAutoParameterizeProposal(manager.document, {
      featureIds: [],
      bodyIds: [selectedBodyId],
      topologies: []
    });
    const bindings = proposal?.operations.filter(
      (operation) => operation.kind === 'set_feature_dimension'
    );
    expect(bindings).toHaveLength(3);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ featureId: selectedFeatureId })
      ])
    );
    expect(bindings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ featureId: otherFeatureId })
      ])
    );
  });

  it('creates an identity-safe exact parameter binding for an imported through-hole', () => {
    const imported = importStepBody(
      createProjectDocument('Imported tube', toUserId('user_auto_step')),
      {
        name: 'Imported Tube',
        artifactId: 'artifact_tube',
        sourceName: 'tube.step',
        stepText: 'ISO-10303-21;END-ISO-10303-21;'
      }
    );
    const bodyId = imported.bodyId;
    const feature = listFeaturesInOrder(imported.document)[0]!;
    const faceReference: FaceTopologyReferenceV5 = {
      kind: 'face',
      producingFeatureId: feature.featureId,
      lineageName: 'imported.face.bore',
      currentHash: 501,
      witnessVersion: 1,
      witness: {
        surfaceType: 'cylinder',
        perimeter: 251327,
        centroid: [0, 0, 5000],
        analytic: {
          kind: 'cylinder',
          axis: [0, 0, 1000],
          axisFoot: [0, 0, 0],
          radius: 4000
        },
        closure: { u: 'closed', v: 'open' }
      }
    };
    imported.document.derived = {
      bodyRepresentations: {
        [bodyId]: {
          bodyId,
          name: 'Imported Tube',
          source: 'imported-step',
          mesh: { kind: 'mesh', vertices: new Float32Array(), indices: new Uint32Array() },
          faceCount: 1,
          color: '#fff',
          exportableStep: true,
          consumed: false,
          volume: 100,
          bbox: {
            min: { x: -10, y: -10, z: 0 },
            max: { x: 10, y: 10, z: 10 }
          },
          topology: {
            faces: [
              {
                topologyId: 'face:bore',
                hash: 501,
                reference: faceReference,
                triangleStart: 0,
                triangleCount: 0,
                geometry: {
                  surfaceType: 'cylinder',
                  area: 251.327412,
                  center: { x: 0, y: 0, z: 5 },
                  radius: 4,
                  diameter: 8,
                  axisStart: { x: 0, y: 0, z: 0 },
                  axisEnd: { x: 0, y: 0, z: 10 },
                  axialLength: 10,
                  featureType: 'through-hole',
                  editableDimension: 'diameter'
                }
              }
            ],
            edges: []
          }
        }
      },
      exportableBodyIds: [bodyId],
      warnings: [],
      updatedAt: imported.document.derived.updatedAt
    };

    const proposal = createAutoParameterizeProposal(imported.document, {
      featureIds: [],
      bodyIds: [bodyId],
      topologies: []
    });
    expect(proposal?.operations).toContainEqual({
      kind: 'set_parameter',
      name: 'imported_tube_hole_1_diameter',
      expression: '8'
    });
    const directEdit = proposal?.operations.find(
      (operation) => operation.kind === 'add_direct_edit'
    );
    expect(directEdit).toMatchObject({
      targetBodyId: bodyId,
      operation: {
        kind: 'resize-through-hole',
        faceReference,
        diameter: 'imported_tube_hole_1_diameter',
        parameterBinding: true
      }
    });
    const parsed = parseCadPatchProposal(structuredClone(proposal));
    expect(parsed.operations).toHaveLength(2);
    const parameterized = new CommandManager(imported.document).runTransaction(
      'Auto-parameterize imported hole',
      commandsForCadPatch(imported.document, parsed)
    );
    expect(
      createAutoParameterizeProposal(parameterized, {
        featureIds: [],
        bodyIds: [bodyId],
        topologies: []
      })
    ).toBeNull();
  });
});
