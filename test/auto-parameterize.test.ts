import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type FaceTopologyReferenceV5,
  type ProjectDocument
} from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

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

async function importedTwoHoleDocument(
  adapter: ExactKernelAdapter
): Promise<ProjectDocument> {
  const source = new CommandManager(
    createProjectDocument('Two-hole source', toUserId('user_auto_two_holes'))
  );
  source.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 20, depth: 8 }
    })
  );

  const topFace = (
    document: ProjectDocument,
    bodyId: ProjectDocument['bodyOrder'][number]
  ) => {
    const body = document.derived.bodyRepresentations[bodyId];
    const face = body?.topology?.faces.find(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        Math.abs(candidate.geometry.center.z - 8) <= 1e-6
    );
    if (!face) {
      throw new Error('Expected the plate top face.');
    }
    return face;
  };

  source.document.derived = await adapter.syncDocument(source.document);
  const plateBodyId = source.document.bodyOrder[0]!;
  const firstTop = topFace(source.document, plateBodyId);
  source.execute(
    commandFactories.holeBody({
      name: 'First bore',
      targetBodyId: plateBodyId,
      faceHash: firstTop.hash,
      ...(firstTop.reference ? { faceReference: firstTop.reference } : {}),
      style: 'simple',
      diameter: 4,
      depthMode: 'through',
      position: { u: -6, v: 0 }
    })
  );

  source.document.derived = await adapter.syncDocument(source.document);
  const firstHoleBodyId = source.document.bodyOrder.at(-1)!;
  const secondTop = topFace(source.document, firstHoleBodyId);
  source.execute(
    commandFactories.holeBody({
      name: 'Second bore',
      targetBodyId: firstHoleBodyId,
      faceHash: secondTop.hash,
      ...(secondTop.reference ? { faceReference: secondTop.reference } : {}),
      style: 'simple',
      diameter: 4,
      depthMode: 'through',
      position: { u: 6, v: 0 }
    })
  );

  const twoHoleBodyId = source.document.bodyOrder.at(-1)!;
  source.document.derived = await adapter.syncDocument(source.document);
  expect(source.document.derived.warnings).toEqual([]);
  const stepText = await adapter.exportStep(source.document, [twoHoleBodyId]);

  const imported = new CommandManager(
    createProjectDocument(
      'Imported two-hole plate',
      toUserId('user_auto_import')
    )
  );
  imported.execute(
    commandFactories.importStep({
      name: 'Imported two-hole plate',
      artifactId: 'artifact_two_hole_plate',
      sourceName: 'two-hole-plate.step',
      stepText
    })
  );
  imported.document.derived = await adapter.syncDocument(imported.document);
  expect(imported.document.derived.warnings).toEqual([]);
  return imported.document;
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

describe(
  'assistant imported multi-hole auto-parameterization',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let imported: ProjectDocument;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      imported = await importedTwoHoleDocument(adapter);
    });

    afterAll(() => {
      adapter.dispose();
    });

    it('preflights and applies multiple no-op bindings without changing geometry', async () => {
      const bodyId = imported.bodyOrder[0]!;
      const before = imported.derived.bodyRepresentations[bodyId]!;
      const proposal = createAutoParameterizeProposal(imported, noSelection);
      expect(
        proposal?.operations.filter(
          (operation) => operation.kind === 'add_direct_edit'
        )
      ).toHaveLength(2);

      const preflight = await preflightCadPatch(
        imported,
        proposal!,
        (candidate) => adapter.syncDocument(candidate)
      );
      const applied = new CommandManager(imported).runTransaction(
        'Apply auto-parameterization',
        preflight.commands
      );
      applied.derived = await adapter.syncDocument(applied);

      const bindings = listFeaturesInOrder(applied).filter(
        (feature) =>
          feature.data.featureKind === 'direct-edit' &&
          feature.data.operation.kind === 'resize-through-hole' &&
          feature.data.operation.parameterBinding
      );
      expect(bindings).toHaveLength(2);
      const after = applied.derived.bodyRepresentations[bodyId]!;
      expect(after.mesh.vertices).toEqual(before.mesh.vertices);
      expect(after.mesh.indices).toEqual(before.mesh.indices);
      expect(after.volume).toBe(before.volume);
      expect(after.faceCount).toBe(before.faceCount);
      expect(
        after.topology?.faces.map((face) => face.reference)
      ).toEqual(before.topology?.faces.map((face) => face.reference));
    });

    it('still rejects a genuinely stale face reference on the no-op path', async () => {
      const proposal = structuredClone(
        createAutoParameterizeProposal(imported, noSelection)!
      );
      const directEdit = proposal.operations.find(
        (operation) => operation.kind === 'add_direct_edit'
      );
      if (
        !directEdit ||
        directEdit.operation.kind !== 'resize-through-hole' ||
        !directEdit.operation.faceReference
      ) {
        throw new Error('Expected an imported through-hole binding.');
      }
      directEdit.operation.faceReference.lineageName += '.stale';

      await expect(
        preflightCadPatch(imported, proposal, (candidate) =>
          adapter.syncDocument(candidate)
        )
      ).rejects.toThrow(/Direct-edit face is stale/);
    });
  }
);
