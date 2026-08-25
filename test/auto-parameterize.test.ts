import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
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

async function importedRecognizedHoleDocument(
  adapter: ExactKernelAdapter,
  style: 'blind' | 'counterbore' | 'countersink'
): Promise<ProjectDocument> {
  const source = new CommandManager(
    createProjectDocument(
      'Recognized-hole source',
      toUserId('user_auto_recognized_source')
    )
  );
  source.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 24, depth: 12 }
    })
  );

  const hole =
    style === 'counterbore'
      ? {
          name: 'Counterbore',
          style: 'counterbore' as const,
          counterboreDiameter: 10,
          counterboreDepth: 3
        }
      : style === 'countersink'
        ? {
            name: 'Countersink',
            style: 'countersink' as const,
            countersinkDiameter: 10,
            countersinkAngleDeg: 90
          }
        : { name: 'Blind bore', style: 'simple' as const };
  source.document.derived = await adapter.syncDocument(source.document);
  const targetBodyId = source.document.bodyOrder.at(-1)!;
  const top = source.document.derived.bodyRepresentations[
    targetBodyId
  ]?.topology?.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.9
  );
  if (!top) {
    throw new Error(`Expected a top face before ${hole.name}.`);
  }
  source.execute(
    commandFactories.holeBody({
      ...hole,
      targetBodyId,
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      diameter: 5,
      depthMode: 'blind',
      depth: 8,
      position: { u: 0, v: 0 }
    })
  );

  const resultBodyId = source.document.bodyOrder.at(-1)!;
  source.document.derived = await adapter.syncDocument(source.document);
  expect(source.document.derived.warnings).toEqual([]);
  const stepText = await adapter.exportStep(source.document, [resultBodyId]);
  const imported = new CommandManager(
    createProjectDocument(
      'Imported recognized holes',
      toUserId('user_auto_recognized_import')
    )
  );
  imported.execute(
    commandFactories.importStep({
      name: 'Imported recognized holes',
      artifactId: `artifact_recognized_${style}`,
      sourceName: `recognized-${style}.step`,
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
          mesh: {
            kind: 'mesh',
            vertices: new Float32Array(),
            indices: new Uint32Array()
          },
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

  it('offers both counterbored and chamfered hammer-holder holes exactly once', () => {
    const imported = importStepBody(
      createProjectDocument(
        'Hammer-holder acceptance shape',
        toUserId('user_auto_hammer')
      ),
      {
        name: 'Hammer Holder',
        artifactId: 'artifact_hammer_holder',
        sourceName: 'Hammer Holder v4.step',
        stepText: 'ISO-10303-21;END-ISO-10303-21;'
      }
    );
    const bodyId = imported.bodyId;
    const feature = listFeaturesInOrder(imported.document)[0]!;
    const reference = (
      hash: number,
      index: number
    ): FaceTopologyReferenceV5 => ({
      kind: 'face',
      producingFeatureId: feature.featureId,
      lineageName: `imported.face.counterbore.${index}`,
      currentHash: hash,
      witnessVersion: 1,
      witness: {
        surfaceType: 'cylinder',
        perimeter: 314159,
        centroid: [index * 1000, 0, 7000],
        analytic: {
          kind: 'cylinder',
          axis: [0, 0, 1000],
          axisFoot: [index * 1000, 0, 0],
          radius: 5000
        },
        closure: { u: 'closed', v: 'open' }
      }
    });
    const firstReference = reference(701, 1);
    const secondReference = reference(702, 2);
    imported.document.derived = {
      bodyRepresentations: {
        [bodyId]: {
          bodyId,
          name: 'Hammer Holder',
          source: 'imported-step',
          mesh: {
            kind: 'mesh',
            vertices: new Float32Array(),
            indices: new Uint32Array()
          },
          faceCount: 12,
          color: '#fff',
          exportableStep: true,
          consumed: false,
          volume: 100,
          bbox: {
            min: { x: -20, y: -20, z: 0 },
            max: { x: 20, y: 20, z: 12 }
          },
          topology: {
            faces: [],
            edges: [],
            recognizedImportedFeatures: [
              {
                kind: 'counterbore',
                seedFaceHash: 701,
                seedFaceReference: firstReference,
                participatingFaceHashes: [701, 711, 721, 731, 741, 751],
                openingPoint: { x: -10, y: 0, z: 12 },
                axisDirection: { x: 0, y: 0, z: -1 },
                boreDiameter: 5,
                counterboreDiameter: 10,
                counterboreDepth: 3,
                totalDepth: 9,
                entryChamfered: true
              },
              {
                kind: 'counterbore',
                seedFaceHash: 702,
                seedFaceReference: secondReference,
                participatingFaceHashes: [702, 712, 722, 732, 742, 752],
                openingPoint: { x: 10, y: 0, z: 12 },
                axisDirection: { x: 0, y: 0, z: -1 },
                boreDiameter: 5,
                counterboreDiameter: 10,
                counterboreDepth: 3,
                totalDepth: 9,
                entryChamfered: true
              }
            ]
          }
        }
      },
      exportableBodyIds: [bodyId],
      warnings: [],
      updatedAt: imported.document.derived.updatedAt
    };

    const parsed = parseCadPatchProposal(
      structuredClone(
        createAutoParameterizeProposal(imported.document, noSelection)
      ),
      createCadDocumentDigest(imported.document)
    );
    const edits = parsed.operations.filter(
      (operation) => operation.kind === 'add_direct_edit'
    );
    expect(edits).toHaveLength(2);
    expect(edits.map((operation) => operation.operation)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'resize-imported-counterbore',
          sourceBoreDiameter: 5,
          sourceCounterboreDiameter: 10,
          sourceEntryChamfered: true
        })
      ])
    );
    expect(
      parsed.operations.filter(
        (operation) =>
          operation.kind === 'set_parameter' && operation.expression === '5'
      )
    ).toHaveLength(2);
    expect(
      parsed.operations.filter(
        (operation) =>
          operation.kind === 'set_parameter' && operation.expression === '10'
      )
    ).toHaveLength(2);
  });

  it('creates one identity-safe radius binding per imported blend region', () => {
    const imported = importStepBody(
      createProjectDocument('Imported bracket', toUserId('user_auto_blend')),
      {
        name: 'Imported Bracket',
        artifactId: 'artifact_blend',
        sourceName: 'bracket.step',
        stepText: 'ISO-10303-21;END-ISO-10303-21;'
      }
    );
    const bodyId = imported.bodyId;
    const feature = listFeaturesInOrder(imported.document)[0]!;
    const reference = (
      hash: number,
      name: string
    ): FaceTopologyReferenceV5 => ({
      kind: 'face',
      producingFeatureId: feature.featureId,
      lineageName: name,
      currentHash: hash,
      witnessVersion: 1,
      witness: {
        surfaceType: 'cylinder',
        perimeter: 18850,
        centroid: [hash, 0, 5000],
        analytic: {
          kind: 'cylinder',
          axis: [0, 0, 1000],
          axisFoot: [hash, 0, 0],
          radius: 3000
        },
        closure: { u: 'open', v: 'open' }
      }
    });
    const blendFace = (
      hash: number,
      index: number,
      regionKey: string,
      regionFaceCount: number,
      radius: number
    ) => ({
      topologyId: `face:blend:${index}`,
      hash,
      reference: reference(hash, `imported.face.blend.${index}`),
      triangleStart: 0,
      triangleCount: 0,
      geometry: {
        surfaceType: 'cylinder' as const,
        area: 30,
        center: { x: index * 10, y: 0, z: 5 },
        radius,
        diameter: radius * 2,
        axisStart: { x: index * 10, y: 0, z: 0 },
        axisEnd: { x: index * 10, y: 0, z: 10 },
        axialLength: 10,
        featureType: 'blend' as const,
        blendRadius: radius,
        blendRegionKey: regionKey,
        blendRegionFaceCount: regionFaceCount,
        editableDimension: 'blendRadius' as const
      }
    });
    const blendFaces = [
      blendFace(601, 1, '7:41,42,43,44', 4, 3),
      blendFace(602, 2, '7:41,42,43,44', 4, 3),
      blendFace(603, 3, '7:41,42,43,44', 4, 3),
      blendFace(701, 4, '7:51', 1, 1.5)
    ];
    imported.document.derived = {
      bodyRepresentations: {
        [bodyId]: {
          bodyId,
          name: 'Imported Bracket',
          source: 'imported-step',
          mesh: {
            kind: 'mesh',
            vertices: new Float32Array(),
            indices: new Uint32Array()
          },
          faceCount: 5,
          color: '#fff',
          exportableStep: true,
          consumed: false,
          volume: 100,
          bbox: {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 50, y: 10, z: 10 }
          },
          topology: { faces: blendFaces, edges: [] }
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
    expect(
      proposal?.operations.filter(
        (operation) => operation.kind === 'set_parameter'
      )
    ).toEqual([
      {
        kind: 'set_parameter',
        name: 'imported_bracket_fillet_1_radius',
        expression: '3'
      },
      {
        kind: 'set_parameter',
        name: 'imported_bracket_fillet_2_radius',
        expression: '1.5'
      }
    ]);
    const edits = proposal?.operations.filter(
      (operation) => operation.kind === 'add_direct_edit'
    );
    expect(edits).toHaveLength(2);
    expect(
      edits?.map((edit) =>
        edit.operation.kind === 'resize-blend'
          ? {
              targetBodyId: edit.targetBodyId,
              kind: edit.operation.kind,
              faceHash: edit.operation.faceHash,
              recordedRadius: edit.operation.recordedRadius,
              newRadius: edit.operation.newRadius,
              parameterBinding: edit.operation.parameterBinding
            }
          : { targetBodyId: edit.targetBodyId, kind: edit.operation.kind }
      )
    ).toEqual([
      {
        targetBodyId: bodyId,
        kind: 'resize-blend',
        faceHash: 601,
        recordedRadius: 3,
        newRadius: 'imported_bracket_fillet_1_radius',
        parameterBinding: true
      },
      {
        targetBodyId: bodyId,
        kind: 'resize-blend',
        faceHash: 701,
        recordedRadius: 1.5,
        newRadius: 'imported_bracket_fillet_2_radius',
        parameterBinding: true
      }
    ]);

    const parsed = parseCadPatchProposal(structuredClone(proposal));
    const parameterized = new CommandManager(imported.document).runTransaction(
      'Auto-parameterize imported blends',
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
      expect(after.topology?.faces.map((face) => face.reference)).toEqual(
        before.topology?.faces.map((face) => face.reference)
      );
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

describe(
  'assistant recognized imported-hole auto-parameterization',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let importedByStyle: Record<
      'blind' | 'counterbore' | 'countersink',
      ProjectDocument
    >;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      importedByStyle = {
        blind: await importedRecognizedHoleDocument(adapter, 'blind'),
        counterbore: await importedRecognizedHoleDocument(
          adapter,
          'counterbore'
        ),
        countersink: await importedRecognizedHoleDocument(
          adapter,
          'countersink'
        )
      };
    });

    afterAll(() => {
      adapter.dispose();
    });

    it('recognizes grouped blind, counterbore, and countersink parameters and applies them as no-ops', async () => {
      const expectations = {
        blind: {
          proof: 'blind-cylindrical-hole',
          edit: 'resize-imported-blind-hole',
          parameters: 2
        },
        counterbore: {
          proof: 'counterbore',
          edit: 'resize-imported-counterbore',
          parameters: 3
        },
        countersink: {
          proof: 'countersink',
          edit: 'resize-imported-countersink',
          parameters: 3
        }
      } as const;

      for (const style of ['blind', 'counterbore', 'countersink'] as const) {
        const imported = importedByStyle[style];
        const bodyId = imported.bodyOrder[0]!;
        const before = imported.derived.bodyRepresentations[bodyId]!;
        expect(
          before.topology?.recognizedImportedFeatures?.map(
            (feature) => feature.kind
          )
        ).toContain(expectations[style].proof);

        const proposal = createAutoParameterizeProposal(imported, noSelection)!;
        const parsed = parseCadPatchProposal(
          structuredClone(proposal),
          createCadDocumentDigest(imported)
        );
        const parameterOperations = parsed.operations.filter(
          (operation) => operation.kind === 'set_parameter'
        );
        const directEdits = parsed.operations.filter(
          (operation) => operation.kind === 'add_direct_edit'
        );
        expect(parameterOperations).toHaveLength(
          expectations[style].parameters
        );
        expect(directEdits).toHaveLength(1);
        expect(directEdits[0]?.operation.kind).toBe(expectations[style].edit);
        expect(parameterOperations.map((operation) => operation.name)).toEqual(
          expect.arrayContaining(
            style === 'blind'
              ? [
                  expect.stringMatching(/hole_1_diameter$/),
                  expect.stringMatching(/hole_1_depth$/)
                ]
              : style === 'counterbore'
                ? [
                    expect.stringMatching(/hole_1_bore_diameter$/),
                    expect.stringMatching(/hole_1_counterbore_diameter$/),
                    expect.stringMatching(/hole_1_counterbore_depth$/)
                  ]
                : [
                    expect.stringMatching(/hole_1_bore_diameter$/),
                    expect.stringMatching(/hole_1_sink_diameter$/),
                    expect.stringMatching(/hole_1_sink_angle_radians$/)
                  ]
          )
        );

        const preflight = await preflightCadPatch(
          imported,
          parsed,
          (candidate) => adapter.syncDocument(candidate)
        );
        const applied = new CommandManager(imported).runTransaction(
          'Apply recognized auto-parameterization',
          preflight.commands
        );
        applied.derived = await adapter.syncDocument(applied);
        const after = applied.derived.bodyRepresentations[bodyId]!;
        expect(after.mesh.vertices).toEqual(before.mesh.vertices);
        expect(after.mesh.indices).toEqual(before.mesh.indices);
        expect(after.volume).toBe(before.volume);
        expect(after.faceCount).toBe(before.faceCount);
        expect(
          listFeaturesInOrder(applied).filter(
            (feature) =>
              feature.data.featureKind === 'direct-edit' &&
              feature.data.operation.kind === expectations[style].edit &&
              feature.data.operation.parameterBinding
          )
        ).toHaveLength(1);
      }
    });

    it.each([
      ['blind', 'diameter', 'blind-cylindrical-hole', 'diameter'],
      ['counterbore', 'boreDiameter', 'counterbore', 'boreDiameter'],
      ['countersink', 'boreDiameter', 'countersink', 'boreDiameter']
    ] as const)(
      're-proves and rebuilds one changed %s diameter',
      async (style, operationField, proofKind, proofField) => {
        const imported = importedByStyle[style];
        const proposal = createAutoParameterizeProposal(imported, noSelection)!;
        const directEdit = proposal.operations.find(
          (operation) => operation.kind === 'add_direct_edit'
        );
        if (!directEdit) {
          throw new Error(`Expected an editable ${style} diameter.`);
        }
        const parameterName =
          style === 'blind' &&
          directEdit.operation.kind === 'resize-imported-blind-hole'
            ? String(directEdit.operation.diameter)
            : style === 'counterbore' &&
                directEdit.operation.kind === 'resize-imported-counterbore'
              ? String(directEdit.operation.boreDiameter)
              : style === 'countersink' &&
                  directEdit.operation.kind === 'resize-imported-countersink'
                ? String(directEdit.operation.boreDiameter)
                : null;
        if (!parameterName) {
          throw new Error(`Expected an editable ${style} ${operationField}.`);
        }
        const preflight = await preflightCadPatch(
          imported,
          proposal,
          (candidate) => adapter.syncDocument(candidate)
        );
        const manager = new CommandManager(preflight.candidate);
        manager.execute(
          commandFactories.setParameter({
            name: parameterName,
            expression: '6'
          })
        );
        manager.document.derived = await adapter.syncDocument(manager.document);
        expect(manager.document.derived.warnings).toEqual([]);
        const liveBody = Object.values(
          manager.document.derived.bodyRepresentations
        ).find((body) => !body.consumed && body.exportableStep);
        const proof = liveBody?.topology?.recognizedImportedFeatures?.find(
          (feature) => feature.kind === proofKind
        );
        expect(proof).toBeDefined();
        const resizedDiameter =
          proof?.kind === 'blind-cylindrical-hole' && proofField === 'diameter'
            ? proof.diameter
            : (proof?.kind === 'counterbore' ||
                  proof?.kind === 'countersink') &&
                proofField === 'boreDiameter'
              ? proof.boreDiameter
              : null;
        expect(resizedDiameter).toBeCloseTo(6, 6);
      }
    );

    it('reports an explicit not-yet-supported error for a changed compound depth', async () => {
      const imported = importedByStyle.counterbore;
      const proposal = createAutoParameterizeProposal(imported, noSelection)!;
      const directEdit = proposal.operations.find(
        (operation) =>
          operation.kind === 'add_direct_edit' &&
          operation.operation.kind === 'resize-imported-counterbore'
      );
      if (
        !directEdit ||
        directEdit.kind !== 'add_direct_edit' ||
        directEdit.operation.kind !== 'resize-imported-counterbore'
      ) {
        throw new Error('Expected an imported counterbore binding.');
      }
      const preflight = await preflightCadPatch(
        imported,
        proposal,
        (candidate) => adapter.syncDocument(candidate)
      );
      const manager = new CommandManager(preflight.candidate);
      manager.execute(
        commandFactories.setParameter({
          name: String(directEdit.operation.counterboreDepth),
          expression: '4'
        })
      );
      manager.document.derived = await adapter.syncDocument(manager.document);
      expect(manager.document.derived.warnings.join('\n')).toMatch(
        /Changing an imported counterbore depth is not yet supported/
      );
    });
  }
);
