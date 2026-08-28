import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  getLatestBodyId,
  listFeaturesInOrder,
  getLatestSketchId,
  getParameterScope,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toBodyId,
  toFeatureId,
  toSketchId,
  toUserId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

describe('command-system', () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => {
    kernel.dispose();
  });

  const edgeReference = {
    kind: 'edge' as const,
    producingFeatureId: toFeatureId('feat_box'),
    lineageName: 'box.edge.front-top',
    currentHash: 42,
    witnessVersion: 1 as const,
    witness: {
      curveType: 'LINE',
      length: 10_000_000,
      closed: false as const,
      endpoints: [
        [0, 0, 0],
        [10_000_000, 0, 0]
      ] as [[number, number, number], [number, number, number]],
      midpoint: [5_000_000, 0, 0] as [number, number, number]
    }
  };

  const faceReference = {
    kind: 'face' as const,
    producingFeatureId: toFeatureId('feat_box'),
    lineageName: 'primitive.box.face.z-max',
    currentHash: 84,
    witnessVersion: 1 as const,
    witness: {
      surfaceType: 'plane',
      perimeter: 40_000_000,
      centroid: [0, 0, 10_000_000] as [number, number, number],
      analytic: {
        kind: 'plane' as const,
        normal: [0, 0, 1_000_000_000] as [number, number, number],
        offset: 10_000_000
      },
      closure: { u: 'open' as const, v: 'open' as const }
    }
  };

  it('supports execute and undo/redo around replayable commands', async () => {
    const manager = new CommandManager(
      createProjectDocument('Command Test', toUserId('user_test'))
    );

    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );

    expect(manager.document.bodyOrder).toHaveLength(1);
    const executedVersion = manager.document.version;
    const executedRevisionCount = manager.document.revisions.length;

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
    expect(manager.document.version).toBeGreaterThan(executedVersion);
    expect(manager.document.revisions).toHaveLength(executedRevisionCount + 1);
    expect(manager.document.revisions.at(-1)?.reason).toBe('Undo Add box');
    const undoneVersion = manager.document.version;

    manager.redo();
    expect(manager.document.bodyOrder).toHaveLength(1);
    expect(manager.document.version).toBeGreaterThan(undoneVersion);
    expect(manager.document.revisions).toHaveLength(executedRevisionCount + 2);
    expect(manager.document.revisions.at(-1)?.reason).toBe('Redo Add box');

    const derived = await kernel.syncDocument(manager.document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(1);
  });

  it('serializes, replays, undoes, and redoes schema-v5 topology references', () => {
    const base = createProjectDocument('Lineage', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    manager.execute(
      commandFactories.filletEdges({
        name: 'Fillet',
        targetBodyId: manager.document.bodyOrder[0]!,
        edgeHashes: [42],
        edgeReferences: [edgeReference],
        size: 1
      })
    );

    const feature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'fillet'
    );
    expect(
      feature?.data.featureKind === 'fillet'
        ? feature.data.edgeReferences
        : undefined
    ).toEqual([edgeReference]);

    const replayed = replayCommands(base, manager.document.commandLog);
    const replayedFeature = Object.values(replayed.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'fillet'
    );
    expect(
      replayedFeature?.data.featureKind === 'fillet'
        ? replayedFeature.data.edgeReferences
        : undefined
    ).toEqual([edgeReference]);
    manager.undo();
    expect(
      Object.values(manager.document.nodes).some(
        (node) => node.kind === 'feature' && node.featureKind === 'fillet'
      )
    ).toBe(false);
    manager.redo();
    expect(
      Object.values(manager.document.nodes).some(
        (node) => node.kind === 'feature' && node.featureKind === 'fillet'
      )
    ).toBe(true);
  });

  it('validates hole commands and replays them deterministically', () => {
    const base = createProjectDocument('Hole replay', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Source',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      })
    );
    const sourceBodyId = manager.document.bodyOrder[0]!;

    // A counterbore no wider than the bore is rejected before it can
    // enter the document.
    expect(() =>
      manager.execute(
        commandFactories.holeBody({
          name: 'Bad seat',
          targetBodyId: sourceBodyId,
          faceHash: 1,
          style: 'counterbore',
          diameter: 6,
          counterboreDiameter: 6,
          counterboreDepth: 3,
          depthMode: 'through',
          position: { u: 0, v: 0 }
        })
      )
    ).toThrow(/larger than the hole diameter/);

    manager.execute(
      commandFactories.holeBody({
        name: 'Bore',
        targetBodyId: sourceBodyId,
        faceHash: 1,
        style: 'simple',
        diameter: '3 * 2',
        depthMode: 'blind',
        depth: 10,
        position: { u: 0, v: 0 }
      })
    );
    expect(manager.document.bodyOrder).toHaveLength(2);

    const replayed = replayCommands(base, manager.document.commandLog);
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);

    manager.undo();
    expect(manager.document.bodyOrder).toEqual([sourceBodyId]);
  });

  it('serializes and replays a split with both result bodies stable', () => {
    const base = createProjectDocument('Split replay', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Source',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      })
    );
    const sourceBodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.splitBody({
        name: 'Halved',
        targetBodyId: sourceBodyId,
        plane: {
          origin: { x: 5, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        }
      })
    );
    // One feature, THREE bodies total: the consumed source plus both halves.
    expect(manager.document.bodyOrder).toHaveLength(3);
    const feature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.data.featureKind === 'split'
    )!;
    expect(feature.bodyId).toBe(manager.document.bodyOrder[1]);
    expect(
      feature.data.featureKind === 'split' && feature.data.secondBodyId
    ).toBe(manager.document.bodyOrder[2]);

    const replayed = replayCommands(base, manager.document.commandLog);
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);

    manager.undo();
    // Undo removes the feature and BOTH result bodies.
    expect(manager.document.bodyOrder).toEqual([sourceBodyId]);
    expect(
      Object.values(manager.document.nodes).some(
        (node) => node.kind === 'feature' && node.data.featureKind === 'split'
      )
    ).toBe(false);
  });

  it('serializes and replays mirror, shell, and solid-offset features', () => {
    const base = createProjectDocument('Modeling v6', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Source',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      })
    );
    const sourceBodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.mirrorBody({
        name: 'Mirrored copy',
        targetBodyId: sourceBodyId,
        plane: {
          origin: { x: 15, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        }
      })
    );
    const mirroredBodyId = manager.document.bodyOrder.at(-1)!;
    manager.execute(
      commandFactories.shellBody({
        name: 'Open shell',
        targetBodyId: mirroredBodyId,
        openingFaceHashes: [faceReference.currentHash],
        openingFaceReferences: [faceReference],
        thickness: 1.5
      })
    );
    const shellBodyId = manager.document.bodyOrder.at(-1)!;
    manager.execute(
      commandFactories.offsetSolidBody({
        name: 'Outward offset',
        targetBodyId: shellBodyId,
        distance: '1 / 2'
      })
    );

    const replayed = replayCommands(base, manager.document.commandLog);
    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(
      Object.values(replayed.nodes)
        .filter((node): node is FeatureNode => node.kind === 'feature')
        .map((node) => node.data.featureKind)
    ).toEqual(['primitive', 'mirror', 'shell', 'solid-offset']);
    expect(replayed.bodyOrder).toContain(sourceBodyId);

    manager.undo();
    expect(
      Object.values(manager.document.nodes).some(
        (node) =>
          node.kind === 'feature' && node.data.featureKind === 'solid-offset'
      )
    ).toBe(false);
    manager.redo();
    expect(manager.document.bodyOrder).toHaveLength(4);

    const featureByKind = (featureKind: FeatureNode['featureKind']) =>
      Object.values(manager.document.nodes).find(
        (node): node is FeatureNode =>
          node.kind === 'feature' && node.featureKind === featureKind
      )!;
    const mirror = featureByKind('mirror');
    const shell = featureByKind('shell');
    const offset = featureByKind('solid-offset');
    const beforeInvalidEdit = structuredClone(manager.document);
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: offset.featureId,
          data: { featureKind: 'solid-offset', distance: 0 }
        })
      )
    ).toThrow(/greater than zero/);
    expect(manager.document).toEqual(beforeInvalidEdit);
    manager.execute(
      commandFactories.updateFeature({
        featureId: mirror.featureId,
        data: {
          featureKind: 'mirror',
          plane: {
            origin: { x: 20, y: 0, z: 0 },
            normal: { x: 0, y: 1, z: 0 }
          }
        }
      })
    );
    manager.execute(
      commandFactories.updateFeature({
        featureId: shell.featureId,
        data: { featureKind: 'shell', thickness: 2 }
      })
    );
    manager.execute(
      commandFactories.updateFeature({
        featureId: offset.featureId,
        data: { featureKind: 'solid-offset', distance: 2 }
      })
    );

    const reloaded = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(reloaded).toEqual(manager.document);
    const replayedEdits = replayCommands(base, manager.document.commandLog);
    expect(replayedEdits.nodes).toEqual(manager.document.nodes);
    expect(replayedEdits.featureOrder).toEqual(manager.document.featureOrder);
    expect(replayedEdits.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(replayedEdits.commandLog).toEqual(manager.document.commandLog);

    for (const featureId of [
      offset.featureId,
      shell.featureId,
      mirror.featureId
    ]) {
      manager.execute(commandFactories.deleteFeature({ featureId }));
    }
    expect(
      Object.values(manager.document.nodes)
        .filter((node): node is FeatureNode => node.kind === 'feature')
        .map((node) => node.featureKind)
    ).toEqual(['primitive']);
  });

  it('rejects invalid modeling preflight without changing history', () => {
    const manager = new CommandManager(
      createProjectDocument('Invalid modeling', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Source',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const before = structuredClone(manager.document);

    expect(() =>
      manager.execute(
        commandFactories.mirrorBody({
          name: 'Invalid mirror',
          targetBodyId: bodyId,
          plane: {
            origin: { x: 0, y: 0, z: 0 },
            normal: { x: 0, y: 0, z: 0 }
          }
        })
      )
    ).toThrow(/normal/);
    expect(() =>
      manager.execute(
        commandFactories.shellBody({
          name: 'Invalid shell',
          targetBodyId: bodyId,
          openingFaceHashes: [],
          thickness: 1
        })
      )
    ).toThrow(/opening faces/);
    expect(() =>
      manager.execute(
        commandFactories.offsetSolidBody({
          name: 'Invalid offset',
          targetBodyId: bodyId,
          distance: 0
        })
      )
    ).toThrow(/greater than zero/);
    expect(manager.document).toEqual(before);
  });

  it('rejects topology references that disagree with their legacy hashes', () => {
    const manager = new CommandManager(
      createProjectDocument('Malformed lineage', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const commandCount = manager.document.commandLog.length;
    expect(() =>
      manager.execute(
        commandFactories.filletEdges({
          name: 'Fillet',
          targetBodyId: manager.document.bodyOrder[0]!,
          edgeHashes: [7],
          edgeReferences: [edgeReference],
          size: 1
        })
      )
    ).toThrow('must uniquely match');
    expect(manager.document.commandLog).toHaveLength(commandCount);
  });

  it('renames the project through replayable undoable document history', () => {
    const base = createProjectDocument('Original Name', toUserId('user_test'));
    const manager = new CommandManager(base);

    manager.execute(
      commandFactories.renameNode({
        nodeId: base.rootNodeId,
        name: 'Renamed Part'
      })
    );

    expect(manager.document.name).toBe('Renamed Part');
    expect(manager.document.nodes[base.rootNodeId]?.name).toBe('Renamed Part');
    expect(replayCommands(base, manager.document.commandLog).name).toBe(
      'Renamed Part'
    );

    manager.undo();
    expect(manager.document.name).toBe('Original Name');
    manager.redo();
    expect(manager.document.name).toBe('Renamed Part');
  });

  it('replays a full parametric command log into an identical entity graph', async () => {
    const base = createProjectDocument('Replay Test', toUserId('user_test'));
    const manager = new CommandManager(base);

    manager.execute(
      commandFactories.setParameter({ name: 'depth', expression: '24' })
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XY',
        offset: 0,
        object: {
          objectKind: 'rectangle',
          width: 32,
          height: 18,
          centerX: 0,
          centerY: 0
        }
      })
    );
    const sketchId = getLatestSketchId(manager.document)!;
    manager.execute(
      commandFactories.extrudeSketch({
        name: 'Extrude',
        sketchId,
        distance: 'depth'
      })
    );
    const bodyId = getLatestBodyId(manager.document)!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: bodyId,
        translation: { x: 5, y: 0, z: 0 }
      })
    );
    const extrudeFeature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'extrude'
    )!;
    manager.execute(
      commandFactories.updateFeature(
        {
          featureId: extrudeFeature.featureId,
          data: { featureKind: 'extrude', sketchId, distance: 'depth / 2' }
        },
        'Halve depth'
      )
    );

    // Commands never mutate their input, so `base` is still the pristine
    // initial document and can serve as the replay starting point.
    const replayed = replayCommands(base, manager.document.commandLog);

    expect(replayed.featureOrder).toEqual(manager.document.featureOrder);
    expect(replayed.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(replayed.sketchOrder).toEqual(manager.document.sketchOrder);
    expect(replayed.parameterOrder).toEqual(manager.document.parameterOrder);
    expect(Object.keys(replayed.nodes).sort()).toEqual(
      Object.keys(manager.document.nodes).sort()
    );
    expect(getParameterScope(replayed).scope).toEqual({ depth: 24 });

    const fromLive = await kernel.syncDocument(manager.document);
    const fromReplay = await kernel.syncDocument(replayed);
    expect(fromReplay.warnings).toEqual([]);
    const live = fromLive.bodyRepresentations[bodyId]!;
    const replay = fromReplay.bodyRepresentations[bodyId]!;
    expect(replay.volume).toBeCloseTo(live.volume, 6);
    expect(replay.volume).toBeCloseTo(32 * 18 * 12, 4);
    expect(replay.bbox).toEqual(live.bbox);
    // The transform is baked into geometry on both paths.
    expect(replay.bbox.min.x).toBeCloseTo(5 - 16, 6);
  });

  it('replays deletions', () => {
    const base = createProjectDocument('Delete Replay', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const feature = Object.values(manager.document.nodes).find(
      (node): node is FeatureNode => node.kind === 'feature'
    )!;
    manager.execute(
      commandFactories.deleteFeature({ featureId: feature.featureId })
    );

    const replayed = replayCommands(base, manager.document.commandLog);
    expect(replayed.bodyOrder).toHaveLength(0);
    expect(replayed.featureOrder).toHaveLength(0);
  });

  it('replays embedded editable STEP imports without losing source data', () => {
    const base = createProjectDocument('STEP Replay', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported',
        artifactId: 'artifact_step',
        sourceName: 'part.step',
        stepText: 'ISO-10303-21;END-ISO-10303-21;'
      })
    );

    const replayed = replayCommands(base, manager.document.commandLog);
    const feature = Object.values(replayed.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'imported-step'
    );
    expect(feature?.data.featureKind).toBe('imported-step');
    if (feature?.data.featureKind === 'imported-step') {
      expect(feature.data.stepText).toContain('ISO-10303-21');
    }

    const importedBodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.directEditBody({
        name: 'Resize through hole',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: 7,
          sourceDiameter: 8,
          sourceAxisStart: { x: 1, y: 2, z: 3 },
          sourceAxisEnd: { x: 1, y: 2, z: 13 },
          diameter: 'hole_diameter'
        }
      })
    );
    const replayedEdit = replayCommands(base, manager.document.commandLog);
    const directEdit = Object.values(replayedEdit.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === 'direct-edit'
    );
    expect(directEdit?.data).toEqual({
      featureKind: 'direct-edit',
      targetBodyId: importedBodyId,
      operation: {
        kind: 'resize-through-hole',
        faceHash: 7,
        sourceDiameter: 8,
        sourceAxisStart: { x: 1, y: 2, z: 3 },
        sourceAxisEnd: { x: 1, y: 2, z: 13 },
        diameter: 'hole_diameter'
      }
    });
    expect(replayedEdit.bodyOrder).toEqual(manager.document.bodyOrder);
  });

  it('validates command preconditions before applying', () => {
    const manager = new CommandManager(
      createProjectDocument('Validate Test', toUserId('user_test'))
    );
    expect(() =>
      manager.execute(
        commandFactories.booleanBodies({
          name: 'Bad union',
          operation: 'union',
          targetBodyIds: manager.document.bodyOrder
        })
      )
    ).toThrow();
    expect(manager.document.commandLog).toHaveLength(0);
  });

  const featureOfKind = (
    document: ProjectDocument,
    featureKind: FeatureNode['featureKind']
  ): FeatureNode =>
    Object.values(document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.featureKind === featureKind
    )!;

  const booleanUpdateFixture = () => {
    const manager = new CommandManager(
      createProjectDocument('Boolean Update', toUserId('user_test'))
    );
    for (const name of ['A', 'B', 'C']) {
      manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        })
      );
    }
    const [first, second, third] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Merged',
        operation: 'union',
        targetBodyIds: [first!, second!]
      })
    );
    return {
      manager,
      first: first!,
      second: second!,
      third: third!,
      feature: featureOfKind(manager.document, 'boolean'),
      resultBodyId: manager.document.bodyOrder.at(-1)!
    };
  };

  it('rejects updating a boolean to fewer than two target bodies', () => {
    const { manager, first, feature } = booleanUpdateFixture();
    const before = structuredClone(manager.document);
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: feature.featureId,
          data: { featureKind: 'boolean', targetBodyIds: [first] }
        })
      )
    ).toThrow(/at least two target bodies/);
    expect(manager.document).toEqual(before);
  });

  it('rejects updating a boolean to duplicate target bodies', () => {
    const { manager, first, feature } = booleanUpdateFixture();
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: feature.featureId,
          data: { featureKind: 'boolean', targetBodyIds: [first, first] }
        })
      )
    ).toThrow(/same body twice/);
  });

  it('rejects updating a boolean to a nonexistent target body', () => {
    const { manager, first, feature } = booleanUpdateFixture();
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: feature.featureId,
          data: {
            featureKind: 'boolean',
            targetBodyIds: [first, toBodyId('body_missing')]
          }
        })
      )
    ).toThrow(/Boolean target body body_missing not found/);
  });

  it('rejects updating a boolean to target its own result body', () => {
    const { manager, first, feature, resultBodyId } = booleanUpdateFixture();
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: feature.featureId,
          data: {
            featureKind: 'boolean',
            targetBodyIds: [first, resultBodyId]
          }
        })
      )
    ).toThrow(/cannot target its own result body/);
  });

  /**
   * The reorder gate has always refused an arrangement where a feature "would
   * run before the body it uses exists". An edit reached the same arrangement
   * without moving a row: every per-kind update check asked whether the
   * referenced body EXISTS, never where in history it exists, and the
   * Inspector's body picker offers the whole of `bodyOrder`.
   *
   * What that cost was silent. The replay is fail-soft per feature, so the
   * transform was skipped behind one warning; a transform node carries no
   * `bodyId`, so the sidebar's failed badge never lit up; and the document was
   * left in a state the reorder gate calls illegal, so unrelated drags started
   * throwing too.
   */
  it('refuses to retarget a transform to a body produced later in history', () => {
    const manager = new CommandManager(
      createProjectDocument('Forward ref', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const boxBodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: boxBodyId,
        translation: { x: 20, y: 0, z: 0 }
      })
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 3, height: 5 }
      })
    );
    const laterBodyId = manager.document.bodyOrder.at(-1)!;
    const move = featureOfKind(manager.document, 'transform');
    const before = structuredClone(manager.document);

    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: move.featureId,
          data: {
            featureKind: 'transform',
            targetBodyId: laterBodyId,
            transform:
              move.data.featureKind === 'transform'
                ? move.data.transform
                : undefined
          }
        })
      )
    ).toThrow(/before the body it uses exists/);
    expect(manager.document).toEqual(before);
  });

  it('accepts a transform retargeted to a body that already exists', () => {
    // The guard must not refuse an ordinary retarget backwards in history,
    // which is the whole point of the Inspector's body picker.
    const manager = new CommandManager(
      createProjectDocument('Backward ref', toUserId('user_test'))
    );
    for (const name of ['Box', 'Second']) {
      manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        })
      );
    }
    const [first, second] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: second!,
        translation: { x: 20, y: 0, z: 0 }
      })
    );
    const move = featureOfKind(manager.document, 'transform');
    manager.execute(
      commandFactories.updateFeature({
        featureId: move.featureId,
        data: {
          featureKind: 'transform',
          targetBodyId: first!,
          transform:
            move.data.featureKind === 'transform'
              ? move.data.transform
              : undefined
        }
      })
    );
    const updated = featureOfKind(manager.document, 'transform');
    expect(
      updated.data.featureKind === 'transform'
        ? updated.data.targetBodyId
        : null
    ).toBe(first);
  });

  it('accepts a boolean update that retargets to live distinct bodies', () => {
    const { manager, first, third, feature } = booleanUpdateFixture();
    manager.execute(
      commandFactories.updateFeature({
        featureId: feature.featureId,
        data: { featureKind: 'boolean', targetBodyIds: [first, third] }
      })
    );
    const updated = featureOfKind(manager.document, 'boolean');
    expect(
      updated.data.featureKind === 'boolean'
        ? updated.data.targetBodyIds
        : undefined
    ).toEqual([first, third]);
  });

  it('rejects updating an extrude to target its own result body', () => {
    const manager = new CommandManager(
      createProjectDocument('Extrude Update', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Base',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 30, depth: 5 }
      })
    );
    const baseBodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XY',
        offset: 5,
        object: {
          objectKind: 'rectangle',
          width: 10,
          height: 10,
          centerX: 0,
          centerY: 0
        }
      })
    );
    manager.execute(
      commandFactories.extrudeSketch({
        name: 'Boss',
        sketchId: getLatestSketchId(manager.document)!,
        distance: 5,
        operation: 'add',
        targetBodyId: baseBodyId
      })
    );
    const extrude = featureOfKind(manager.document, 'extrude');
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: extrude.featureId,
          data: { featureKind: 'extrude', targetBodyId: extrude.bodyId }
        })
      )
    ).toThrow(/cannot target its own result body/);
    // A same-target update of another field still passes.
    manager.execute(
      commandFactories.updateFeature({
        featureId: extrude.featureId,
        data: { featureKind: 'extrude', distance: 8 }
      })
    );
    const updated = featureOfKind(manager.document, 'extrude');
    expect(
      updated.data.featureKind === 'extrude' ? updated.data.distance : undefined
    ).toBe(8);
  });

  it('rejects updating a revolve to a nonexistent sketch', () => {
    const manager = new CommandManager(
      createProjectDocument('Revolve Update', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XZ',
        offset: 0,
        object: {
          objectKind: 'rectangle',
          width: 10,
          height: 10,
          centerX: 10,
          centerY: 0
        }
      })
    );
    manager.execute(
      commandFactories.revolveSketch({
        name: 'Ring',
        sketchId: getLatestSketchId(manager.document)!,
        axis: 'vertical'
      })
    );
    const revolve = featureOfKind(manager.document, 'revolve');
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: revolve.featureId,
          data: {
            featureKind: 'revolve',
            sketchId: toSketchId('sketch_missing')
          }
        })
      )
    ).toThrow(/existing sketch/);
    manager.execute(
      commandFactories.updateFeature({
        featureId: revolve.featureId,
        data: { featureKind: 'revolve', angleDeg: 180 }
      })
    );
    const updated = featureOfKind(manager.document, 'revolve');
    expect(
      updated.data.featureKind === 'revolve' ? updated.data.angleDeg : undefined
    ).toBe(180);
  });

  it('rejects updating a revolve to a sketch produced later in history', () => {
    const manager = new CommandManager(
      createProjectDocument('Revolve History', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'First profile',
        plane: 'XZ',
        offset: 0,
        object: {
          objectKind: 'rectangle',
          width: 10,
          height: 10,
          centerX: 10,
          centerY: 0
        }
      })
    );
    manager.execute(
      commandFactories.revolveSketch({
        name: 'Ring',
        sketchId: getLatestSketchId(manager.document)!,
        axis: 'vertical'
      })
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Later profile',
        plane: 'XZ',
        offset: 0,
        object: {
          objectKind: 'rectangle',
          width: 5,
          height: 5,
          centerX: 15,
          centerY: 0
        }
      })
    );
    const laterSketchId = getLatestSketchId(manager.document)!;
    const revolve = featureOfKind(manager.document, 'revolve');
    const before = structuredClone(manager.document);

    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: revolve.featureId,
          data: { featureKind: 'revolve', sketchId: laterSketchId }
        })
      )
    ).toThrow(/before the sketch it uses exists/);
    expect(manager.document).toEqual(before);
  });

  it('rejects updating fillet, transform, and pattern features to a nonexistent body', () => {
    const manager = new CommandManager(
      createProjectDocument('Retarget Update', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.filletEdges({
        name: 'Fillet',
        targetBodyId: bodyId,
        edgeHashes: [42],
        edgeReferences: [edgeReference],
        size: 1
      })
    );
    manager.execute(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: bodyId,
        translation: { x: 5, y: 0, z: 0 }
      })
    );
    manager.execute(
      commandFactories.patternBody({
        name: 'Row',
        targetBodyId: bodyId,
        patternKind: 'linear',
        count: 3,
        axis: 'x',
        spacing: 20,
        angleDeg: 360
      })
    );
    const fillet = featureOfKind(manager.document, 'fillet');
    const transform = featureOfKind(manager.document, 'transform');
    const pattern = featureOfKind(manager.document, 'pattern');

    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: fillet.featureId,
          data: { featureKind: 'fillet', targetBodyId: toBodyId('body_missing') }
        })
      )
    ).toThrow(/Target body body_missing not found/);
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: transform.featureId,
          data: {
            featureKind: 'transform',
            targetBodyId: toBodyId('body_missing')
          }
        })
      )
    ).toThrow(/Transform target body body_missing not found/);
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: pattern.featureId,
          data: {
            featureKind: 'pattern',
            targetBodyId: toBodyId('body_missing')
          }
        })
      )
    ).toThrow(/Target body body_missing not found/);

    // Valid value edits on the same features still pass.
    manager.execute(
      commandFactories.updateFeature({
        featureId: fillet.featureId,
        data: { featureKind: 'fillet', radius: 2 }
      })
    );
    manager.execute(
      commandFactories.updateFeature({
        featureId: transform.featureId,
        data: {
          featureKind: 'transform',
          transform: {
            translation: { x: 7, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        }
      })
    );
    manager.execute(
      commandFactories.updateFeature({
        featureId: pattern.featureId,
        data: { featureKind: 'pattern', count: 5 }
      })
    );
    const updatedFillet = featureOfKind(manager.document, 'fillet');
    expect(
      updatedFillet.data.featureKind === 'fillet'
        ? updatedFillet.data.radius
        : undefined
    ).toBe(2);
    const updatedPattern = featureOfKind(manager.document, 'pattern');
    expect(
      updatedPattern.data.featureKind === 'pattern'
        ? updatedPattern.data.count
        : undefined
    ).toBe(5);
  });

  it('clears the redo stack when a new command is executed after undo', () => {
    const manager = new CommandManager(
      createProjectDocument('History Test', toUserId('user_test'))
    );
    const box = (name: string) =>
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      });

    manager.execute(box('A'));
    manager.execute(box('B'));
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(1);

    manager.execute(box('C'));
    const afterC = manager.document;
    manager.redo();
    expect(manager.document).toBe(afterC);
  });

  it('records transactions as a single undoable step', () => {
    const manager = new CommandManager(
      createProjectDocument('Txn Test', toUserId('user_test'))
    );
    manager.runTransaction('Two boxes', [
      commandFactories.addPrimitive({
        name: 'A',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      }),
      commandFactories.addPrimitive({
        name: 'B',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      })
    ]);
    expect(manager.document.bodyOrder).toHaveLength(2);
    expect(manager.document.commandLog).toHaveLength(2);

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
    expect(manager.document.revisions.at(-1)?.reason).toBe('Undo Two boxes');
  });

  it('preserves durable checkpoints while undoing model history', () => {
    const manager = new CommandManager(
      createProjectDocument('Checkpoint Test', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    manager.document = {
      ...manager.document,
      checkpoints: [
        ...manager.document.checkpoints,
        {
          checkpointId: 'checkpoint_manual',
          revisionId: manager.document.revisions.at(-1)!.revisionId,
          documentVersion: manager.document.version,
          createdAt: new Date().toISOString(),
          reason: 'Manual save'
        }
      ]
    };

    manager.undo();

    expect(manager.document.checkpoints.at(-1)?.reason).toBe('Manual save');
    expect(manager.document.bodyOrder).toHaveLength(0);
  });

  it('turns a reviewed AI patch into normal undoable commands', () => {
    const manager = new CommandManager(
      createProjectDocument('AI Patch', toUserId('user_test'))
    );
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_1',
      summary: 'Add a driven mounting block.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'width', expression: '80' },
        {
          kind: 'add_primitive',
          name: 'Mounting block',
          primitiveKind: 'box',
          dimensions: {
            width: 'width',
            height: 20,
            depth: 8,
            radius: null,
            bottomRadius: null,
            topRadius: null,
            majorRadius: null,
            minorRadius: null
          }
        }
      ]
    });

    manager.runTransaction('Apply AI patch', commands);
    expect(manager.document.parameterOrder).toHaveLength(1);
    expect(manager.document.bodyOrder).toHaveLength(1);
    manager.undo();
    expect(manager.document.parameterOrder).toHaveLength(0);
    expect(manager.document.bodyOrder).toHaveLength(0);
  });

  it('converts advanced AI operations into replayable feature commands', () => {
    const manager = new CommandManager(
      createProjectDocument('Advanced AI Patch', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Seed',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_advanced',
      summary: 'Move and repeat the seed.',
      assumptions: [],
      operations: [
        {
          kind: 'add_transform',
          name: 'Move seed',
          targetBodyId: bodyId,
          translation: { x: 5, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        },
        {
          kind: 'add_pattern',
          name: 'Seed pattern',
          targetBodyId: bodyId,
          patternKind: 'linear',
          count: 3,
          axis: 'x',
          spacing: 20,
          angleDeg: 360
        }
      ]
    });

    manager.runTransaction('Apply advanced AI patch', commands);
    expect(manager.document.commandLog.at(-2)?.kind).toBe('feature.transform');
    expect(manager.document.commandLog.at(-1)?.kind).toBe('feature.pattern');
    expect(manager.document.featureOrder).toHaveLength(3);
  });

  it('builds a hollow part from bodies created inside the same patch', () => {
    const manager = new CommandManager(
      createProjectDocument('Hollow Box', toUserId('user_test'))
    );
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_hollow',
      summary: 'Hollow the box.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'wall', expression: '2.4' },
        {
          kind: 'add_primitive',
          name: 'Box Outer',
          localId: 'box_outer',
          primitiveKind: 'box',
          dimensions: {
            width: 120,
            height: 80,
            depth: 60,
            radius: null,
            bottomRadius: null,
            topRadius: null,
            majorRadius: null,
            minorRadius: null
          }
        },
        {
          kind: 'add_primitive',
          name: 'Box Cavity',
          localId: 'box_cavity',
          primitiveKind: 'box',
          dimensions: {
            width: '120 - 2*wall',
            height: '80 - 2*wall',
            depth: '60 - wall',
            radius: null,
            bottomRadius: null,
            topRadius: null,
            majorRadius: null,
            minorRadius: null
          }
        },
        {
          kind: 'add_transform',
          name: 'Position Box Cavity',
          targetBodyId: '$box_cavity',
          translation: { x: 'wall', y: 'wall', z: 'wall' },
          rotationDeg: { x: 0, y: 0, z: 0 }
        },
        {
          kind: 'add_boolean',
          name: 'Box',
          localId: 'box',
          operation: 'subtract',
          targetBodyIds: ['$box_outer', '$box_cavity']
        }
      ]
    });

    manager.runTransaction('Apply hollow patch', commands);

    // The boolean must target the two bodies the patch itself created.
    const booleanCommand = manager.document.commandLog.at(-1);
    expect(booleanCommand?.kind).toBe('feature.boolean');
    const payload = booleanCommand?.payload as {
      targetBodyIds: string[];
    };
    const createdBodies = manager.document.bodyOrder;
    expect(payload.targetBodyIds).toEqual([createdBodies[0], createdBodies[1]]);
    // Aliases are an AI-only concept and must never reach the command log.
    expect(JSON.stringify(manager.document.commandLog)).not.toContain('$');
    expect(manager.document.bodyOrder).toHaveLength(3);

    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
  });

  it('rejects a patch that references a body it never creates', () => {
    const manager = new CommandManager(
      createProjectDocument('Dangling', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_dangling',
        summary: 'Move a body that does not exist.',
        assumptions: [],
        operations: [
          {
            kind: 'add_transform',
            name: 'Move ghost',
            targetBodyId: '$ghost',
            translation: { x: 1, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/no earlier operation creates that body/);
  });

  it('rejects re-targeting a body a boolean already consumed', () => {
    const manager = new CommandManager(
      createProjectDocument('Consumed', toUserId('user_test'))
    );
    const box = (name: string, localId: string) =>
      ({
        kind: 'add_primitive',
        name,
        localId,
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
      }) as const;

    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_consumed',
        summary: 'Reuse a consumed body.',
        assumptions: [],
        operations: [
          box('A', 'a'),
          box('B', 'b'),
          {
            kind: 'add_boolean',
            name: 'Merged',
            localId: 'merged',
            operation: 'subtract',
            targetBodyIds: ['$a', '$b']
          },
          {
            kind: 'add_transform',
            name: 'Move consumed tool',
            targetBodyId: '$b',
            translation: { x: 5, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/already consumed/);
  });

  it('accepts an expression that is only valid at the real parameter values', () => {
    const manager = new CommandManager(
      createProjectDocument('Real Values', toUserId('user_test'))
    );
    // hole_count - 1 divides by zero under any placeholder of 1, so this is
    // only checkable against the values the patch actually produces.
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_pitch',
      summary: 'Space the holes evenly.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'total_len', expression: '120' },
        { kind: 'set_parameter', name: 'hole_count', expression: '4' },
        {
          kind: 'set_parameter',
          name: 'pitch',
          expression: 'total_len / (hole_count - 1)'
        }
      ]
    });
    manager.runTransaction('Apply pitch', commands);
    expect(getParameterScope(manager.document).scope.pitch).toBeCloseTo(40);
  });

  it('rejects an expression that cannot produce a finite number', () => {
    const manager = new CommandManager(
      createProjectDocument('Divide By Zero', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_infinite',
        summary: 'Divide by zero.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter', name: 'wall', expression: '0' },
          {
            kind: 'add_primitive',
            name: 'Bad',
            localId: null,
            primitiveKind: 'box',
            dimensions: {
              width: '10 / wall',
              height: 10,
              depth: 10,
              radius: null,
              bottomRadius: null,
              topRadius: null,
              majorRadius: null,
              minorRadius: null
            }
          }
        ]
      })
    ).toThrow(/finite/);
  });

  it('rejects parameters that reference each other in a cycle', () => {
    const manager = new CommandManager(
      createProjectDocument('Cycle', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_cycle',
        summary: 'Define a cycle.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter', name: 'a', expression: 'b + 1' },
          { kind: 'set_parameter', name: 'b', expression: 'a + 1' }
        ]
      })
    ).toThrow(/depends on itself/);
  });

  it('rejects a parameter named after a built-in', () => {
    const manager = new CommandManager(
      createProjectDocument('Reserved', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_reserved',
        summary: 'Shadow a built-in.',
        assumptions: [],
        operations: [{ kind: 'set_parameter', name: 'pi', expression: '3' }]
      })
    ).toThrow(/not usable/);
  });

  it('rejects targeting a body an earlier turn already consumed', () => {
    const manager = new CommandManager(
      createProjectDocument('Earlier Turn', toUserId('user_test'))
    );
    const box = (name: string) =>
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    manager.execute(box('A'));
    manager.execute(box('B'));
    const [first, second] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Merged',
        operation: 'union',
        targetBodyIds: [first!, second!]
      })
    );
    // Mark the operands consumed the way a kernel sync would.
    const derived = {
      ...manager.document.derived,
      bodyRepresentations: Object.fromEntries(
        manager.document.bodyOrder.map((bodyId) => [
          bodyId,
          { consumed: bodyId !== manager.document.bodyOrder.at(-1) }
        ])
      )
    } as ProjectDocument['derived'];
    const document = { ...manager.document, derived };

    expect(() =>
      commandsForCadPatch(document, {
        proposalId: 'proposal_dead_body',
        summary: 'Move an absorbed body.',
        assumptions: [],
        operations: [
          {
            kind: 'add_transform',
            name: 'Move absorbed',
            targetBodyId: first!,
            translation: { x: 5, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/already consumed/);
  });

  it('rejects a consumed body even when derived state has not been rebuilt', () => {
    // Consumption must be read from the canonical feature history, not only
    // from derived state: a document loaded but not yet rebuilt has empty
    // bodyRepresentations, and validation has to fail closed without them.
    const manager = new CommandManager(
      createProjectDocument('No Derived Yet', toUserId('user_test'))
    );
    const box = (name: string) =>
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    manager.execute(box('A'));
    manager.execute(box('B'));
    const [first, second] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Merged',
        operation: 'union',
        targetBodyIds: [first!, second!]
      })
    );
    expect(manager.document.derived.bodyRepresentations).toEqual({});

    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_stale_derived',
        summary: 'Move an absorbed body before any rebuild.',
        assumptions: [],
        operations: [
          {
            kind: 'add_transform',
            name: 'Move absorbed',
            targetBodyId: first!,
            translation: { x: 5, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        ]
      })
    ).toThrow(/already consumed/);
  });

  it('rejects a parameter expression the evaluator cannot read', () => {
    const manager = new CommandManager(
      createProjectDocument('Bad Expression', toUserId('user_test'))
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_bad_expression',
        summary: 'Set a broken parameter.',
        assumptions: [],
        operations: [{ kind: 'set_parameter', name: 'wall', expression: '2 +' }]
      })
    ).toThrow(/invalid expression/);
  });

  it('accepts parameters that reference each other in any order', () => {
    const manager = new CommandManager(
      createProjectDocument('Cross Params', toUserId('user_test'))
    );
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_cross',
      summary: 'Derive the cavity from the shell.',
      assumptions: [],
      operations: [
        {
          kind: 'set_parameter',
          name: 'cavity_len',
          expression: 'box_len - 2*wall'
        },
        { kind: 'set_parameter', name: 'box_len', expression: '120' },
        { kind: 'set_parameter', name: 'wall', expression: '2.4' }
      ]
    });
    manager.runTransaction('Apply cross params', commands);
    expect(getParameterScope(manager.document).scope.cavity_len).toBeCloseTo(
      115.2
    );
  });

  it('replays sketch constraint commands with undo and redo', () => {
    const base = createProjectDocument('Constraint Log', toUserId('user_test'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 2 },
          { objectKind: 'line', x1: 0, y1: 5, x2: 10, y2: 8 }
        ]
      })
    );
    const sketchId = getLatestSketchId(manager.document)!;
    const findConstraintSketch = (document: ProjectDocument) =>
      Object.values(document.nodes).find(
        (node) => node.kind === 'sketch' && node.sketchId === sketchId
      );
    const sketch = findConstraintSketch(manager.document)!;
    const [lineA, lineB] =
      sketch.kind === 'sketch' ? sketch.objectIds : [undefined, undefined];

    manager.execute(
      commandFactories.addSketchConstraint({
        sketchId,
        constraint: { constraintKind: 'parallel', a: lineA!, b: lineB! }
      })
    );
    const afterAdd = findConstraintSketch(manager.document)!;
    const constraintId =
      afterAdd.kind === 'sketch'
        ? afterAdd.constraints![0]!.constraintId
        : undefined;
    expect(constraintId).toBeTruthy();

    manager.execute(
      commandFactories.deleteSketchConstraint({
        sketchId,
        constraintId: constraintId!
      })
    );
    const afterDelete = findConstraintSketch(manager.document)!;
    expect(
      afterDelete.kind === 'sketch' ? afterDelete.constraints : undefined
    ).toHaveLength(0);

    // Undo restores the constraint under its recorded id; redo removes it
    // again; a from-scratch replay of the log agrees with the live document.
    manager.undo();
    const undone = findConstraintSketch(manager.document)!;
    expect(
      undone.kind === 'sketch'
        ? undone.constraints![0]!.constraintId
        : undefined
    ).toBe(constraintId);
    manager.redo();

    const replayed = replayCommands(base, manager.document.commandLog);
    const replayedSketch = Object.values(replayed.nodes).find(
      (node) => node.kind === 'sketch'
    );
    expect(
      replayedSketch?.kind === 'sketch' ? replayedSketch.constraints : undefined
    ).toHaveLength(0);
  });
});

describe('a command that changes nothing', () => {
  it('does not bump the version, append a revision, or burn an undo slot', () => {
    // `runTransaction` and `applyDocumentEdit` both refused a no-op; `execute`
    // did not. `moveFeature` returns its input for an out-of-range index, which
    // is what ArrowUp on the first row produces — so holding the key appended a
    // "Reorder" revision, pushed a dead undo entry, and (because the version is
    // part of the geometry sync key) posted a full WASM rebuild, per press.
    // About a hundred of them evicted the user's real undo history.
    const manager = new CommandManager(
      createProjectDocument('No-op', toUserId('user_noop'))
    );
    const box = manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const featureId = listFeaturesInOrder(box)[0]!.featureId;
    const before = {
      version: manager.document.version,
      revisions: manager.document.revisions.length,
      commandLog: manager.document.commandLog.length,
      canUndo: manager.canUndo
    };

    const after = manager.execute(
      commandFactories.moveFeature({ featureId, toIndex: -1 })
    );

    expect(after).toBe(box);
    expect(manager.document.version).toBe(before.version);
    expect(manager.document.revisions).toHaveLength(before.revisions);
    expect(manager.document.commandLog).toHaveLength(before.commandLog);
    expect(manager.canUndo).toBe(before.canUndo);
  });

  it('still undoes the real edit that preceded it', () => {
    // The point of the guard: the undo stack keeps pointing at the user's own
    // work rather than at a stack of dead reorders.
    const manager = new CommandManager(
      createProjectDocument('No-op', toUserId('user_noop'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const featureId = listFeaturesInOrder(manager.document)[0]!.featureId;
    for (let press = 0; press < 20; press += 1) {
      manager.execute(commandFactories.moveFeature({ featureId, toIndex: -1 }));
    }

    const undone = manager.undo();
    expect(listFeaturesInOrder(undone)).toHaveLength(0);
  });
});
