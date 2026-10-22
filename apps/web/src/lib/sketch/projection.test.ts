import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { frameForPlaneRef } from '@openzcad/geometry';
import {
  edgeTopologyWitnessHash,
  toBodyId,
  toUserId,
  type BodyRepresentation,
  type EdgeTopology,
  type EdgeTopologyReferenceV5,
  type FeatureId,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData,
  type SketchProjectionState
} from '@openzcad/shared';
import {
  assertProjectionsResolve,
  projectionAddCommand,
  projectionFromPick,
  projectionFromPickWithLineage,
  projectionRoleLabel,
  projectionWriteBackCommand,
  repickedProjectionData,
  sketchProjectionRows,
  sketchesWithBrokenProjections,
  unlinkedProjectionData
} from './projection';

/**
 * I01 sketch projection, browser side: what a pick projects, how a moved
 * linked projection is written back, and the words U06 uses for each.
 */

const plane = { type: 'canonical', plane: 'XY', offset: 2 } as const;
const basis = frameForPlaneRef(plane, (value) => Number(value));
const bodyId = toBodyId('body_block');

function reference(name: string, hash: number): EdgeTopologyReferenceV5 {
  const result: EdgeTopologyReferenceV5 = {
    kind: 'edge',
    producingFeatureId: 'feat_block' as FeatureId,
    lineageName: name,
    currentHash: hash,
    witnessVersion: 1,
    witness: {
      curveType: 'LINE',
      length: 1,
      closed: false,
      endpoints: [
        [0, 0, 0],
        [1, 0, 0]
      ],
      midpoint: [0, 0, 0]
    }
  };
  result.currentHash = edgeTopologyWitnessHash(result.witness);
  return result;
}

const line = (
  id: string,
  hash: number,
  from: [number, number, number],
  to: [number, number, number],
  faces: number[],
  verified = true
): EdgeTopology => ({
  topologyId: id,
  hash,
  ...(verified ? { reference: reference(`edge.${id}`, hash) } : {}),
  curve: { type: 'LINE' },
  adjacentFaceHashes: faces,
  points: [...from, ...to]
});

/** A 4 × 3 top face (hash 50) whose four edges are published. */
const edges: EdgeTopology[] = [
  line('a', 1, [0, 0, 5], [4, 0, 5], [50, 60]),
  line('b', 2, [4, 0, 5], [4, 3, 5], [50, 61]),
  line('c', 3, [4, 3, 5], [0, 3, 5], [50, 62], false),
  line('d', 4, [0, 3, 5], [0, 0, 5], [50, 63]),
  // A vertical edge: it projects to a point.
  line('e', 5, [0, 0, 0], [0, 0, 5], [60, 63])
];

function modelDocument(): ProjectDocument {
  const base = addPrimitiveFeature(
    createProjectDocument('Projection', toUserId('user_projection')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 3, depth: 5 }
    }
  );
  // The published topology names the block's own feature as producer.
  const producer = listFeaturesInOrder(base).at(-1)!.featureId;
  const named = edges.map((edge) =>
    edge.reference
      ? {
          ...edge,
          reference: { ...edge.reference, producingFeatureId: producer }
        }
      : edge
  );
  return {
    ...base,
    derived: {
      ...base.derived,
      bodyRepresentations: {
        [bodyId]: {
          bodyId,
          name: 'Block',
          topology: { faces: [], edges: named }
        } as unknown as BodyRepresentation
      }
    }
  };
}

describe('projectionFromPick', () => {
  it('retries an idle-skipped linked pick with verified lineage before refusing it', async () => {
    const document = modelDocument();
    let rebuilt = 0;
    const pick = await projectionFromPickWithLineage(
      {
        document,
        sketch: null,
        selection: { bodyId, kind: 'face', hash: 50 },
        basis,
        mode: 'linked',
        construction: false
      },
      {
        cancelled: () => false,
        rebuildWithLineage: async () => {
          rebuilt++;
          const updated = structuredClone(document);
          const topology =
            updated.derived.bodyRepresentations[bodyId]!.topology!;
          const producer = listFeaturesInOrder(updated).at(-1)!.featureId;
          topology.edges = topology.edges.map((edge) => ({
            ...edge,
            reference: edge.reference ?? {
              ...reference('edge.c', edge.hash),
              producingFeatureId: producer
            }
          }));
          return updated;
        }
      }
    );
    expect(rebuilt).toBe(1);
    expect(pick?.objects).toHaveLength(4);
    expect(
      pick?.objects.every((object) => object.projection?.mode === 'linked')
    ).toBe(true);
    expect(pick?.skipped).toEqual([]);
  });

  it('does not apply a lineage rebuild after the sketch command was withdrawn', async () => {
    let cancelled = false;
    const pick = await projectionFromPickWithLineage(
      {
        document: modelDocument(),
        sketch: null,
        selection: { bodyId, kind: 'face', hash: 50 },
        basis,
        mode: 'linked',
        construction: false
      },
      {
        cancelled: () => cancelled,
        rebuildWithLineage: async () => {
          cancelled = true;
          return modelDocument();
        }
      }
    );
    expect(pick).toBeNull();
  });

  it('projects one picked edge, linked to its verified source', () => {
    const document = modelDocument();
    const pick = projectionFromPick({
      document,
      sketch: null,
      selection: { bodyId, kind: 'edge', topologyId: 'a', hash: 1 },
      basis,
      mode: 'linked',
      construction: false
    });
    expect(pick.skipped).toEqual([]);
    expect(pick.objects).toEqual([
      {
        objectKind: 'line',
        x1: 0,
        y1: 0,
        x2: 4,
        y2: 0,
        projection: {
          mode: 'linked',
          source: {
            bodyId,
            edgeReference: expect.objectContaining({
              lineageName: 'edge.a'
            }) as unknown
          }
        }
      }
    ]);
  });

  it('projects a face boundary, leaving out an edge without verified identity', () => {
    const pick = projectionFromPick({
      document: modelDocument(),
      sketch: null,
      selection: { bodyId, kind: 'face', topologyId: 'top', hash: 50 },
      basis,
      mode: 'linked',
      construction: true
    });
    expect(pick.objects).toHaveLength(3);
    expect(pick.objects.every((object) => object.construction === true)).toBe(
      true
    );
    expect(pick.skipped).toEqual([
      expect.stringMatching(/no verified identity/)
    ]);
    // Unlinked copies every edge; the one without identity has no source.
    const copy = projectionFromPick({
      document: modelDocument(),
      sketch: null,
      selection: { bodyId, kind: 'face', topologyId: 'top', hash: 50 },
      basis,
      mode: 'unlinked',
      construction: false
    });
    expect(copy.objects).toHaveLength(4);
    expect(copy.objects.map((object) => object.projection)).toEqual([
      { mode: 'unlinked', source: expect.anything() as unknown },
      { mode: 'unlinked', source: expect.anything() as unknown },
      { mode: 'unlinked' },
      { mode: 'unlinked', source: expect.anything() as unknown }
    ]);
  });

  it('does not project the same edge linked twice into one sketch', () => {
    const document = modelDocument();
    const first = projectionFromPick({
      document,
      sketch: null,
      selection: { bodyId, kind: 'edge', topologyId: 'a', hash: 1 },
      basis,
      mode: 'linked',
      construction: false
    });
    const sketched = addSketchFeature(document, {
      name: 'S',
      planeRef: plane,
      objects: first.objects
    });
    expect(() =>
      projectionFromPick({
        document: sketched.document,
        sketch: findSketch(sketched.document, sketched.sketchId)!,
        selection: { bodyId, kind: 'edge', topologyId: 'a', hash: 1 },
        basis,
        mode: 'linked',
        construction: false
      })
    ).toThrow(/already projected linked/);
  });

  it('keeps the duplicate check on a re-pick, except for the object repaired', () => {
    const document = modelDocument();
    const pickEdge = (topologyId: string, hash: number) =>
      projectionFromPick({
        document,
        sketch: null,
        selection: { bodyId, kind: 'edge', topologyId, hash },
        basis,
        mode: 'linked',
        construction: false
      }).objects;
    const sketched = addSketchFeature(document, {
      name: 'S',
      planeRef: plane,
      objects: [...pickEdge('a', 1), ...pickEdge('b', 2)]
    });
    const sketch = findSketch(sketched.document, sketched.sketchId)!;
    const [onA, onB] = sketch.objectIds;
    const repick = (repairing: string, topologyId: string, hash: number) =>
      projectionFromPick({
        document: sketched.document,
        sketch,
        selection: { bodyId, kind: 'edge', topologyId, hash },
        basis,
        mode: 'linked',
        construction: false,
        repairing
      });
    // Re-picking B onto A's edge would leave two coincident linked lines.
    expect(() => repick(onB!, 'a', 1)).toThrow(/already projected linked/);
    // Re-picking A onto its own edge (or a fresh one) is the repair itself.
    expect(repick(onA!, 'a', 1).objects).toHaveLength(1);
    expect(repick(onA!, 'd', 4).objects).toHaveLength(1);
  });

  it('refuses by name what does not project', () => {
    const document = modelDocument();
    const pick = (
      selection: Parameters<typeof projectionFromPick>[0]['selection']
    ) =>
      projectionFromPick({
        document,
        sketch: null,
        selection,
        basis,
        mode: 'linked',
        construction: false
      });
    expect(() =>
      pick({ bodyId, kind: 'edge', topologyId: 'e', hash: 5 })
    ).toThrow(/projects to a point/);
    expect(() => pick({ bodyId, kind: 'body' })).toThrow(/Pick a model edge/);
    expect(() =>
      pick({ bodyId, kind: 'edge', topologyId: 'gone', hash: 99 })
    ).toThrow(/no longer part of the model/);
  });
});

describe('writing a moved projection back', () => {
  function projectedSketch() {
    const document = modelDocument();
    const { objects } = projectionFromPick({
      document,
      sketch: null,
      selection: { bodyId, kind: 'edge', topologyId: 'a', hash: 1 },
      basis,
      mode: 'linked',
      construction: true
    });
    const sketched = addSketchFeature(document, {
      name: 'S',
      planeRef: plane,
      objects
    });
    const objectId = findSketch(sketched.document, sketched.sketchId)!
      .objectIds[0]!;
    return { ...sketched, objectId, stored: objects[0]! };
  }

  it('updates the object to where the build re-projected it, keeping its role', () => {
    const { document, objectId, stored } = projectedSketch();
    const moved = { ...stored, x2: 9 } as SketchObjectData;
    const command = projectionWriteBackCommand(document, {
      sketchProjections: { [objectId]: { status: 'moved', data: moved } }
    });
    expect(command).not.toBeNull();
    const next = command!.apply(document);
    const node = next.nodes[objectId];
    expect(node?.kind === 'sketch-object' && node.data).toEqual({
      ...moved,
      construction: true
    });
  });

  it('leaves alone what is current, broken, unlinked or re-sourced since', () => {
    const { document, objectId, stored } = projectedSketch();
    const states = (state: SketchProjectionState) => ({
      sketchProjections: { [objectId]: state }
    });
    expect(
      projectionWriteBackCommand(document, states({ status: 'current' }))
    ).toBeNull();
    expect(
      projectionWriteBackCommand(
        document,
        states({ status: 'broken', reason: 'gone' })
      )
    ).toBeNull();
    const elsewhere = {
      ...stored,
      projection: {
        mode: 'linked' as const,
        source: {
          bodyId,
          edgeReference: reference('edge.other', 7)
        }
      }
    };
    expect(
      projectionWriteBackCommand(
        document,
        states({ status: 'moved', data: elsewhere })
      )
    ).toBeNull();
  });
});

describe('repair, unlink and the words for each', () => {
  const linked: SketchObjectData = {
    objectKind: 'line',
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 0,
    construction: true,
    projection: {
      mode: 'linked',
      source: { bodyId, edgeReference: reference('edge.a', 1) }
    }
  };

  it('unlinks to an independent copy that keeps its geometry and provenance', () => {
    expect(unlinkedProjectionData(linked)).toEqual({
      ...linked,
      projection: {
        mode: 'unlinked',
        source: { bodyId, edgeReference: reference('edge.a', 1) }
      }
    });
  });

  it('re-picks only the same kind of curve, keeping the object’s role', () => {
    const replacement: SketchObjectData = {
      objectKind: 'line',
      x1: 2,
      y1: 2,
      x2: 3,
      y2: 2,
      projection: {
        mode: 'linked',
        source: { bodyId, edgeReference: reference('edge.b', 2) }
      }
    };
    expect(repickedProjectionData(linked, replacement)).toEqual({
      ...replacement,
      construction: true
    });
    expect(() =>
      repickedProjectionData(linked, {
        objectKind: 'circle',
        centerX: 0,
        centerY: 0,
        radius: 1,
        projection: replacement.projection
      })
    ).toThrow(/projects to a line/);
  });

  it('keeps constrained start and end identity when a re-picked line runs backward', () => {
    const replacement: SketchObjectData = {
      objectKind: 'line',
      x1: 1.25,
      y1: 0.25,
      x2: 0.25,
      y2: 0.25,
      projection: {
        mode: 'linked',
        source: { bodyId, edgeReference: reference('edge.repicked', 2) }
      }
    };
    const before = structuredClone(replacement);
    expect(repickedProjectionData(linked, replacement)).toEqual({
      ...replacement,
      x1: 0.25,
      x2: 1.25,
      construction: true
    });
    expect(replacement).toEqual(before);
  });

  it('refuses a candidate whose new projection the build could not re-find', () => {
    expect(() =>
      assertProjectionsResolve(
        {
          sketchProjections: {
            ent_a: {
              status: 'broken',
              reason:
                "its source body is unavailable at the sketch's place in the history."
            }
          }
        },
        ['ent_a']
      )
    ).toThrow(/cannot be projected linked here: the source body/);
    expect(() =>
      assertProjectionsResolve(
        { sketchProjections: { ent_a: { status: 'moved', data: linked } } },
        ['ent_a']
      )
    ).not.toThrow();
    // No verdict (a suppressed sketch, or one whose plane failed) proves
    // nothing about the edge, so it is refused too.
    expect(() => assertProjectionsResolve({}, ['ent_a'])).toThrow(
      /the sketch did not build/
    );
    expect(() =>
      assertProjectionsResolve(
        { sketchProjections: { ent_b: { status: 'current' } } },
        ['ent_a']
      )
    ).toThrow(/the sketch did not build/);
  });

  it('describes each projection for History and Objects', () => {
    const document = modelDocument();
    const sketched = addSketchFeature(document, {
      name: 'S',
      planeRef: plane,
      objects: [
        linked,
        { ...linked, projection: { mode: 'unlinked' } },
        { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }
      ]
    });
    const sketch = findSketch(sketched.document, sketched.sketchId)!;
    const [first] = sketch.objectIds;
    const broken: ProjectDocument = {
      ...sketched.document,
      derived: {
        ...sketched.document.derived,
        sketchProjections: {
          [first!]: { status: 'broken', reason: 'its edge was deleted.' }
        }
      }
    };
    const rows = sketchProjectionRows(broken, sketch);
    expect(rows).toEqual([
      expect.objectContaining({
        mode: 'linked',
        state: 'broken',
        reason: 'its edge was deleted.',
        sourceName: null
      }),
      expect.objectContaining({ mode: 'unlinked', sourceName: null })
    ]);
    expect(rows.map(projectionRoleLabel)).toEqual([
      'Linked · broken',
      'Independent copy'
    ]);
    expect(sketchesWithBrokenProjections(broken)).toEqual(
      new Set([sketched.sketchId])
    );
  });

  it('adds a pick to the session sketch, or starts one, with known ids', () => {
    const added = projectionAddCommand({
      sketchId: 'sketch_s' as SketchId,
      objects: [linked, linked],
      mode: 'linked'
    });
    expect(added.objectIds).toHaveLength(2);
    expect(added.command.label).toBe('Project 2 edges');
    const started = projectionAddCommand({
      sketchId: null,
      newSketch: { name: 'Sketch 01', planeRef: plane },
      objects: [linked],
      mode: 'unlinked'
    });
    const next = started.command.apply(modelDocument());
    expect(findSketch(next, started.sketchId)?.objectIds).toEqual(
      started.objectIds
    );
  });
});
