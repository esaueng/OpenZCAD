import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  addSplitFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  listFeaturesInOrder,
  mirrorBody,
  normalizeDocument,
  setNodeMetadata,
  updateFeature,
  updateSketch
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  FEATURE_SUPPRESSED_METADATA_KEY,
  type BodyId,
  type DatumPlaneDefinition,
  type FeatureId,
  type ProjectDocument,
  type SketchPlaneRef
} from '@openzcad/shared';

const xy = (offset = 0) =>
  ({ type: 'canonical', plane: 'XY', offset }) as const;
const datum = (datumFeatureId: FeatureId) =>
  ({ type: 'datum', datumFeatureId }) as const;

function blank(name = 'Datum planes'): ProjectDocument {
  return createProjectDocument(name, toUserId('user_datum'));
}

function withDatum(
  document: ProjectDocument,
  definition: DatumPlaneDefinition,
  name = 'Plane'
) {
  return addDatumPlane(document, { name, definition });
}

/** A 4 × 6 rectangle on `planeRef`, extruded 5 along the plane normal. */
function padOn(document: ProjectDocument, planeRef: SketchPlaneRef) {
  const sketched = addSketchFeature(document, {
    name: 'Pad sketch',
    planeRef,
    objects: [
      { objectKind: 'rectangle', width: 4, height: 6, centerX: 0, centerY: 0 }
    ]
  });
  return extrudeSketch(sketched.document, {
    name: 'Pad',
    sketchId: sketched.sketchId,
    distance: 5
  });
}

describe('R01 datum planes in the document', () => {
  it('is a schema-19 feature in history that owns no body', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(19);
    const base = blank();
    const { document, featureId } = withDatum(base, {
      kind: 'offset',
      source: xy(),
      offset: 10
    });
    const feature = listFeaturesInOrder(document).at(-1)!;
    expect(feature.featureId).toBe(featureId);
    expect(feature.data).toEqual({
      featureKind: 'datum-plane',
      definition: { kind: 'offset', source: xy(), offset: 10 }
    });
    expect(feature.bodyId).toBeUndefined();
    expect(document.bodyOrder).toEqual(base.bodyOrder);
  });

  it('round-trips a v19 document and opens a v18 one unchanged', () => {
    const planed = withDatum(blank(), {
      kind: 'offset',
      source: xy(),
      offset: '8 + 2'
    });
    const saved = JSON.parse(
      JSON.stringify(planed.document)
    ) as ProjectDocument;
    expect(saved.schemaVersion).toBe(19);
    expect(normalizeDocument(saved)).toEqual(planed.document);

    const legacy = { ...blank(), schemaVersion: 18 as 19 };
    const opened = normalizeDocument(structuredClone(legacy));
    expect(opened.schemaVersion).toBe(19);
    expect({ ...opened, schemaVersion: 18 }).toEqual(legacy);
    expect(() =>
      normalizeDocument({ ...saved, schemaVersion: 20 as 19 })
    ).toThrow('Unsupported project schema (v20)');
  });

  it('refuses sources that are not earlier datums or real planes', () => {
    const base = blank();
    const first = withDatum(base, { kind: 'offset', source: xy(), offset: 5 });
    expect(() =>
      withDatum(first.document, {
        kind: 'offset',
        source: datum('feat_missing' as FeatureId),
        offset: 1
      })
    ).toThrow(/No datum plane/);
    expect(() =>
      withDatum(first.document, {
        kind: 'offset',
        source: xy(),
        offset: Number.NaN
      })
    ).toThrow(/finite/);
    expect(() =>
      withDatum(first.document, {
        kind: 'midplane',
        sources: [datum(first.featureId), datum(first.featureId)]
      })
    ).toThrow(/two different/);
    expect(() =>
      withDatum(first.document, {
        kind: 'offset',
        source: {
          type: 'face',
          bodyId: 'body_missing',
          faceHash: 1,
          sourceArea: 1,
          sourceCenter: { x: 0, y: 0, z: 0 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          frame: {
            origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { x: 0, y: 0, z: 1 }
          }
        } as never,
        offset: 1
      })
    ).toThrow(/qualified lineage reference/);
  });

  it('lets sketches, Mirror and Split name only an existing datum', () => {
    const base = addPrimitiveFeature(blank(), {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const bodyId = base.bodyOrder[0]!;
    const missing = datum('feat_missing' as FeatureId);
    expect(() =>
      addSketchFeature(base, { name: 'Lost', planeRef: missing })
    ).toThrow(/No datum plane/);
    expect(() =>
      mirrorBody(base, { name: 'Lost', targetBodyId: bodyId, plane: missing })
    ).toThrow(/No datum plane/);
    expect(() =>
      addSplitFeature(base, {
        name: 'Lost',
        targetBodyId: bodyId,
        plane: missing
      })
    ).toThrow(/No datum plane/);
  });

  it('refuses re-pointing a sketch at a datum that comes after it', () => {
    const sketched = addSketchFeature(blank(), {
      name: 'Early',
      planeRef: xy()
    });
    const later = withDatum(sketched.document, {
      kind: 'offset',
      source: xy(),
      offset: 3
    });
    expect(() =>
      updateSketch(later.document, {
        sketchId: sketched.sketchId,
        planeRef: datum(later.featureId)
      })
    ).toThrow(/comes later in history/);
  });

  it('refuses deleting a datum that something still uses, listing it', () => {
    const planed = withDatum(
      blank(),
      { kind: 'offset', source: xy(), offset: 10 },
      'Lid plane'
    );
    const chained = withDatum(
      planed.document,
      { kind: 'offset', source: datum(planed.featureId), offset: 2 },
      'Upper plane'
    );
    const padded = padOn(chained.document, datum(planed.featureId));
    expect(() =>
      deleteFeature(padded.document, { featureId: planed.featureId })
    ).toThrow(
      'Cannot delete datum plane "Lid plane": Upper plane, Pad sketch use it.'
    );
    // An unused datum deletes normally.
    const bare = deleteFeature(chained.document, {
      featureId: chained.featureId
    });
    expect(
      listFeaturesInOrder(bare).some(
        (feature) => feature.featureId === chained.featureId
      )
    ).toBe(false);
  });

  it('refuses an edit that points a datum at itself or a later one', () => {
    const first = withDatum(blank(), {
      kind: 'offset',
      source: xy(),
      offset: 1
    });
    const second = withDatum(first.document, {
      kind: 'offset',
      source: datum(first.featureId),
      offset: 1
    });
    expect(() =>
      updateFeature(second.document, {
        featureId: first.featureId,
        data: {
          featureKind: 'datum-plane',
          definition: {
            kind: 'offset',
            source: datum(second.featureId),
            offset: 1
          }
        }
      })
    ).toThrow(/comes later in history/);
    expect(() =>
      updateFeature(second.document, {
        featureId: first.featureId,
        data: {
          featureKind: 'datum-plane',
          definition: {
            kind: 'offset',
            source: datum(first.featureId),
            offset: 1
          }
        }
      })
    ).toThrow(/its own source/);
  });

  it('refuses a reorder that would replay a sketch before its datum', () => {
    const planed = withDatum(blank(), {
      kind: 'offset',
      source: xy(),
      offset: 10
    });
    const padded = padOn(planed.document, datum(planed.featureId));
    const manager = new CommandManager(padded.document);
    const sketchFeature = listFeaturesInOrder(padded.document).find(
      (feature) => feature.data.featureKind === 'sketch'
    )!;
    expect(() =>
      manager.execute(
        commandFactories.moveFeature({
          featureId: sketchFeature.featureId,
          toIndex: 0
        })
      )
    ).toThrow(/before the feature it depends on/);
    // Moving the datum after the sketch is the same arrangement.
    expect(() =>
      manager.execute(
        commandFactories.moveFeature({
          featureId: planed.featureId,
          toIndex: 1
        })
      )
    ).toThrow(/before the feature it depends on/);
  });
});

describe('R01 datum planes in the exact build', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function bbox(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    expect(body).toBeDefined();
    return body!.bbox;
  }

  it.each([
    [10, 10, 15],
    [0, 0, 5],
    [-4, -4, 1]
  ])(
    'sketches on an XY datum offset %d and extrudes from it',
    async (offset, minZ, maxZ) => {
      const planed = withDatum(blank(), {
        kind: 'offset',
        source: xy(),
        offset
      });
      const padded = padOn(planed.document, datum(planed.featureId));
      const box = await bbox(padded.document, padded.bodyId);
      expect(box.min.z).toBeCloseTo(minZ, 6);
      expect(box.max.z).toBeCloseTo(maxZ, 6);
      expect(box.max.x - box.min.x).toBeCloseTo(4, 6);
    }
  );

  it('chains datums and flips an offset with reverseNormal', async () => {
    const first = withDatum(blank(), {
      kind: 'offset',
      source: xy(),
      offset: 10
    });
    const second = withDatum(first.document, {
      kind: 'offset',
      source: datum(first.featureId),
      offset: -4,
      reverseNormal: true
    });
    const padded = padOn(second.document, datum(second.featureId));
    const box = await bbox(padded.document, padded.bodyId);
    // At z = 6, extruding down the reversed normal.
    expect(box.max.z).toBeCloseTo(6, 6);
    expect(box.min.z).toBeCloseTo(1, 6);
  });

  it('places a midplane halfway between parallel sources', async () => {
    const top = withDatum(blank(), {
      kind: 'offset',
      source: xy(),
      offset: 20
    });
    const mid = withDatum(top.document, {
      kind: 'midplane',
      sources: [xy(4), datum(top.featureId)]
    });
    const padded = padOn(mid.document, datum(mid.featureId));
    const box = await bbox(padded.document, padded.bodyId);
    expect(box.min.z).toBeCloseTo(12, 6);
    expect(box.max.z).toBeCloseTo(17, 6);
  });

  it('refuses a midplane between nonparallel planes by name', async () => {
    const tilted = withDatum(blank(), {
      kind: 'midplane',
      sources: [xy(), { type: 'canonical', plane: 'YZ', offset: 0 }]
    });
    const derived = await adapter.syncDocument(tilted.document);
    expect(derived.warnings.join('\n')).toMatch(/not parallel/);
  });

  it('splits and mirrors across a datum', async () => {
    const base = addPrimitiveFeature(blank(), {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const bodyId = base.bodyOrder[0]!;
    const planed = withDatum(base, {
      kind: 'offset',
      source: { type: 'canonical', plane: 'YZ', offset: 0 },
      offset: 5
    });
    const split = addSplitFeature(planed.document, {
      name: 'Half',
      targetBodyId: bodyId,
      plane: datum(planed.featureId)
    });
    const derived = await adapter.syncDocument(split.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[split.bodyId]?.volume).toBeCloseTo(
      15 * 20 * 20,
      6
    );
    expect(derived.bodyRepresentations[split.secondBodyId]?.volume).toBeCloseTo(
      5 * 20 * 20,
      6
    );

    const far = withDatum(base, {
      kind: 'offset',
      source: { type: 'canonical', plane: 'YZ', offset: 0 },
      offset: 30
    });
    const mirrored = mirrorBody(far.document, {
      name: 'Mirror',
      targetBodyId: bodyId,
      plane: datum(far.featureId)
    }).document;
    const box = await bbox(mirrored, mirrored.bodyOrder.at(-1)!);
    expect(box.min.x).toBeCloseTo(40, 6);
    expect(box.max.x).toBeCloseTo(60, 6);
  });

  it('publishes each resolved datum frame in the derived state', async () => {
    const planed = withDatum(blank(), {
      kind: 'offset',
      source: xy(),
      offset: 10,
      reverseNormal: true
    });
    const derived = await adapter.syncDocument(planed.document);
    const frame = derived.datumFrames?.[planed.featureId];
    expect(frame?.origin.z).toBeCloseTo(10, 9);
    expect(frame?.normal.z).toBeCloseTo(-1, 9);
    // A suppressed datum has no frame to publish.
    const node = listFeaturesInOrder(planed.document).at(-1)!;
    const suppressed = await adapter.syncDocument(
      setNodeMetadata(planed.document, {
        nodeId: node.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    expect(suppressed.datumFrames?.[planed.featureId]).toBeUndefined();
  });

  it('moves every consumer when the datum is edited, through the cache', async () => {
    const planed = withDatum(blank(), {
      kind: 'offset',
      source: xy(),
      offset: 10
    });
    const padded = padOn(planed.document, datum(planed.featureId));
    expect((await bbox(padded.document, padded.bodyId)).min.z).toBeCloseTo(
      10,
      6
    );
    const edited = updateFeature(padded.document, {
      featureId: planed.featureId,
      data: {
        featureKind: 'datum-plane',
        definition: { kind: 'offset', source: xy(), offset: 12 }
      }
    });
    expect((await bbox(edited, padded.bodyId)).min.z).toBeCloseTo(12, 6);
    // Undoing the edit restores the earlier placement.
    expect((await bbox(padded.document, padded.bodyId)).min.z).toBeCloseTo(
      10,
      6
    );
  });

  it('skips the consumers of a suppressed datum, naming it', async () => {
    const planed = withDatum(
      blank(),
      { kind: 'offset', source: xy(), offset: 10 },
      'Lid plane'
    );
    const padded = padOn(planed.document, datum(planed.featureId));
    const datumNode = listFeaturesInOrder(padded.document).find(
      (feature) => feature.featureId === planed.featureId
    )!;
    const suppressed = setNodeMetadata(padded.document, {
      nodeId: datumNode.id,
      metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
    });
    const derived = await adapter.syncDocument(suppressed);
    expect(derived.warnings.join('\n')).toMatch(
      /datum plane "Lid plane" because it is unavailable/
    );
    expect(derived.bodyRepresentations[padded.bodyId]).toBeUndefined();
  });
});

describe('feature.datum-plane command (R01-C)', () => {
  it('replays a Plane card commit to the same datum id and definition', () => {
    const manager = new CommandManager(blank('Datum replay'));
    const command = commandFactories.addDatumPlane({
      name: 'Lid plane',
      definition: { kind: 'offset', source: xy(), offset: 'lid' }
    });
    manager.execute(command);
    const featureId = command.payload.ids!.featureId;
    const replayed = replayCommands(blank('Datum replay'), [
      command.serialize()
    ]);
    const feature = listFeaturesInOrder(replayed).find(
      (candidate) => candidate.featureId === featureId
    );
    expect(feature?.name).toBe('Lid plane');
    expect(feature?.data).toEqual({
      featureKind: 'datum-plane',
      definition: { kind: 'offset', source: xy(), offset: 'lid' }
    });
  });

  it('refuses a definition that names a datum not yet in history', () => {
    const command = commandFactories.addDatumPlane({
      name: 'Orphan',
      definition: {
        kind: 'offset',
        source: datum('feat_missing' as FeatureId),
        offset: 1
      }
    });
    expect(() => command.validate(blank())).toThrow(
      'No datum plane feat_missing exists.'
    );
  });
});
