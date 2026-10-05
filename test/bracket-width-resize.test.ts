import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  attachDerivedState,
  createBodyFeatureIds,
  createParameterIds,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  FEATURE_SUPPRESSED_METADATA_KEY,
  type BodyId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  buildModelingOperationSubmission,
  modelingFaceOptions
} from '../apps/web/src/lib/modelingOperations';
import { validateFeatureSuppression } from '../apps/web/src/lib/featureSuppression';

/**
 * F1 of the 1 October 2026 design review: a bracket built the way a new user
 * builds one — two corner-origin boxes that touch, a union, a fillet on the
 * inside corner, two holes on the plate — driven by a `width` parameter.
 * Setting `width` 80 → 120 was refused whole: the inside corner edge is NEW,
 * made where the union joins the plate's top to the flange's front, so it had
 * no lineage name, the fillet held it by position hash alone, and the hash
 * moved with the width. The holes then lost their target body with it.
 *
 * The union now names a generated edge after the two named operand faces the
 * kernel says made it, so the fillet finds the same edge after the resize.
 */
describe('a primitive-built bracket follows its width parameter', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  async function synced(document: ProjectDocument) {
    return attachDerivedState(document, await adapter.syncDocument(document));
  }

  const along = (edge: EdgeTopology, offset: number) =>
    edge.points.filter((_, index) => index % 3 === offset);

  /** Straight edges at y = 5, z = 5 running along X: the inside corner. */
  function insideCorner(document: ProjectDocument, bodyId: BodyId) {
    return document.derived.bodyRepresentations[bodyId]!.topology!.edges.filter(
      (edge) => {
        const xs = along(edge, 0);
        return (
          along(edge, 1).every((y) => Math.abs(y - 5) < 1e-6) &&
          along(edge, 2).every((z) => Math.abs(z - 5) < 1e-6) &&
          Math.max(...xs) - Math.min(...xs) > 60
        );
      }
    );
  }

  it('rebuilds fillet and holes after width 80 → 120', async () => {
    const base = createProjectDocument(
      'Bracket',
      toUserId('user_bracket_width'),
      'mm'
    );
    const manager = new CommandManager(base);
    const run = (label: string, commands: AnyCommand[]) =>
      manager.runTransaction(label, commands);
    const width = (expression: string) =>
      commandFactories.setParameter({
        name: 'width',
        expression,
        ids: createParameterIds()
      });

    run('Width', [width('80')]);
    const plate = createBodyFeatureIds();
    const flange = createBodyFeatureIds();
    const union = createBodyFeatureIds();
    run('Bracket', [
      commandFactories.addPrimitive({
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 'width', height: 40, depth: 5 },
        ids: plate
      }),
      commandFactories.addPrimitive({
        name: 'Flange',
        primitiveKind: 'box',
        dimensions: { width: 'width', height: 5, depth: 40 },
        ids: flange
      }),
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [plate.bodyId, flange.bodyId],
        ids: union
      })
    ]);
    let document = await synced(manager.document);

    const [corner, ...others] = insideCorner(document, union.bodyId);
    expect(others).toHaveLength(0);
    // The seam the union made carries a name of its own.
    expect(corner!.reference?.lineageName).toBe(
      'boolean.edge.between.operand.0.primitive.box.face.z-max|operand.1.primitive.box.face.y-max'
    );

    const fillet = createBodyFeatureIds();
    run('Fillet', [
      commandFactories.filletEdges({
        name: 'Fillet',
        targetBodyId: union.bodyId,
        edgeHashes: [corner!.hash],
        edgeReferences: [corner!.reference!],
        size: 3,
        ids: fillet
      })
    ]);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);

    let target: BodyId = fillet.bodyId;
    for (const [index, v] of ['width/2-15', '-(width/2-15)'].entries()) {
      const body = document.derived.bodyRepresentations[target]!;
      const top = body.topology!.faces.find(
        (face) =>
          face.geometry?.normal?.z === 1 &&
          Math.abs((face.geometry.centroid ?? face.geometry.center).z - 5) <
            1e-6
      )!;
      const submission = buildModelingOperationSubmission(
        {
          operation: 'hole',
          value: {
            name: `Hole ${index + 1}`,
            targetBodyId: target,
            faceHash: top.hash,
            style: 'simple',
            diameter: '6',
            depthMode: 'through',
            depth: '5',
            counterboreDiameter: '10',
            counterboreDepth: '2',
            countersinkDiameter: '10',
            countersinkAngleDeg: '90',
            position: { u: '-10', v }
          }
        },
        modelingFaceOptions(body.topology, body)
      );
      if (submission.operation !== 'hole') throw new Error('Not a hole.');
      run(`Hole ${index + 1}`, [commandFactories.holeBody(submission.input)]);
      document = await synced(manager.document);
      target = listFeaturesInOrder(document).at(-1)!.bodyId as BodyId;
    }
    expect(document.derived.warnings).toEqual([]);
    const narrow = document.derived.bodyRepresentations[target]!;

    run('Resize', [width('120')]);
    document = await synced(manager.document);

    expect(document.derived.warnings).toEqual([]);
    const wide = document.derived.bodyRepresentations[target]!;
    expect(wide.bbox.max.x - wide.bbox.min.x).toBeCloseTo(120, 6);
    // The fillet is still on the inside corner: the rounded body is 40 mm
    // less wide only by the width change, and its blend sits at the corner.
    const blends = wide.topology!.faces.filter(
      (face) => face.geometry?.featureType === 'blend'
    );
    expect(blends).toHaveLength(1);
    // Both holes moved with `width/2-15`: two bores, now 90 mm apart. A bore
    // wall's `center` is the mean of its sampled vertices, not its axis, so
    // the spacing is read to the millimetre.
    const bores = (representation: typeof wide) =>
      representation
        .topology!.faces.filter(
          (face) => face.geometry?.featureType === 'through-hole'
        )
        .map((face) => face.geometry!.center)
        .map((point) => point.x)
        .sort((a, b) => a - b);
    const before = bores(narrow);
    const after = bores(wide);
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(after[1]! - after[0]!).toBeCloseTo(90, 0);
    expect(before[1]! - before[0]!).toBeCloseTo(50, 0);

    // F1's remaining case: the holes keep their exact stored references when
    // the resized bracket's fillet is paused. Compare warm history restore to
    // a cold command replay, then restore the original filleted result.
    const features = listFeaturesInOrder(manager.document);
    const filletFeature = features.find(
      (feature) => feature.featureId === fillet.featureId
    )!;
    const holeData = structuredClone(
      features
        .filter((feature) => feature.data.featureKind === 'hole')
        .map((feature) => feature.data)
    );
    const geometrySignature = (body: typeof wide) => ({
      faces: body
        .topology!.faces.map((face) => face.hash)
        .sort((a, b) => a - b),
      edges: body
        .topology!.edges.map((edge) => edge.hash)
        .sort((a, b) => a - b),
      volume: body.volume
    });
    const filleted = geometrySignature(wide);
    run('Suppress Fillet', [
      commandFactories.setNodeMetadata({
        nodeId: filletFeature.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    ]);
    const suppressed = await adapter.syncDocument(manager.document);
    expect(
      suppressed.featureWarnings?.map(({ featureId, kind }) => ({
        featureId,
        kind
      }))
    ).toEqual([{ featureId: fillet.featureId, kind: 'suppressed' }]);
    expect(() =>
      validateFeatureSuppression(manager.document, suppressed, filletFeature)
    ).not.toThrow();
    const plain = suppressed.bodyRepresentations[target]!;
    expect(
      plain.topology!.faces.filter(
        (face) => face.geometry?.featureType === 'blend'
      )
    ).toHaveLength(0);
    const plainBores = bores(plain);
    expect(plainBores).toHaveLength(2);
    expect(plainBores[1]! - plainBores[0]!).toBeCloseTo(90, 0);
    expect(plain.volume).toBeCloseTo(45_000 - 2 * Math.PI * 9 * 5, 3);
    expect(
      Object.values(suppressed.bodyRepresentations)
        .filter((body) => !body.consumed)
        .map((body) => body.bodyId)
    ).toEqual([target]);
    expect(suppressed.referenceRepairs ?? []).toEqual([]);
    expect(suppressed.faceReferenceRepairs ?? []).toEqual([]);
    expect(
      listFeaturesInOrder(manager.document)
        .filter((feature) => feature.data.featureKind === 'hole')
        .map((feature) => feature.data)
    ).toEqual(holeData);

    const cold = await createExactKernelAdapter();
    try {
      const replayed = replayCommands(base, manager.document.commandLog);
      const rebuilt = await cold.syncDocument(replayed);
      expect(geometrySignature(rebuilt.bodyRepresentations[target]!)).toEqual(
        geometrySignature(plain)
      );
    } finally {
      cold.dispose();
    }
    manager.undo();
    const resumed = await adapter.syncDocument(manager.document);
    expect(resumed.warnings).toEqual([]);
    expect(geometrySignature(resumed.bodyRepresentations[target]!)).toEqual(
      filleted
    );
    manager.redo();
    expect(
      geometrySignature(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          target
        ]!
      )
    ).toEqual(geometrySignature(plain));
  }, 240_000);

  it('keeps every edge of the union when all of them are rounded', async () => {
    // The union also trims edges (the plate's top side edge now stops at the
    // flange) and splits them (its bottom side edge breaks where the flange
    // lands). Rounding every edge reaches all of those too.
    const manager = new CommandManager(
      createProjectDocument('All edges', toUserId('user_bracket_all'), 'mm')
    );
    const width = (expression: string) =>
      commandFactories.setParameter({
        name: 'width',
        expression,
        ids: createParameterIds()
      });
    const plate = createBodyFeatureIds();
    const flange = createBodyFeatureIds();
    const union = createBodyFeatureIds();
    manager.runTransaction('Bracket', [
      width('80'),
      commandFactories.addPrimitive({
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 'width', height: 40, depth: 5 },
        ids: plate
      }),
      commandFactories.addPrimitive({
        name: 'Flange',
        primitiveKind: 'box',
        dimensions: { width: 'width', height: 5, depth: 40 },
        ids: flange
      }),
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [plate.bodyId, flange.bodyId],
        ids: union
      })
    ]);
    let document = await synced(manager.document);
    const edges = document.derived.bodyRepresentations[
      union.bodyId
    ]!.topology!.edges.filter((edge) => edge.displayRole !== 'seam');
    expect(edges.filter((edge) => !edge.reference)).toEqual([]);

    const fillet = createBodyFeatureIds();
    manager.runTransaction('Round everything', [
      commandFactories.filletEdges({
        name: 'Round',
        targetBodyId: union.bodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        edgeReferences: edges.map((edge) => edge.reference!),
        size: 1,
        ids: fillet
      })
    ]);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);

    manager.runTransaction('Resize', [width('120')]);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    const body = document.derived.bodyRepresentations[fillet.bodyId]!;
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(120, 6);
  }, 240_000);
});
