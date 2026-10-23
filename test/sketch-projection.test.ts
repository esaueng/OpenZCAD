import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchConstraint,
  addSketchFeature,
  booleanBodies,
  addSketchObjects,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder,
  normalizeDocument,
  setParameter,
  updateSketchObject
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  frameForPlaneRef,
  projectEdgeToSketch,
  projectableCurveFromTopology,
  type PlaneBasis
} from '@openzcad/geometry';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  edgeTopologyWitnessHash,
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopology,
  type EntityId,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData,
  type SketchPlaneRef,
  type SketchProjectionMode
} from '@openzcad/shared';
import { projectionFromPickWithLineage } from '../apps/web/src/lib/sketch/projection';

/**
 * I01 sketch projection (schema v33) against the exact kernel: a linked
 * projection follows its edge through an upstream resize — the downstream
 * extrude follows in the same rebuild — a deleted source turns broken and
 * keeps building from the last valid geometry, an unlinked copy never moves,
 * and a fresh pick projects exactly what the build re-projects, so a stored
 * document is never rewritten on load.
 */

const above: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 8 };
const basis: PlaneBasis = frameForPlaneRef(above, (value) => Number(value));

function blank(): ProjectDocument {
  return createProjectDocument('Projection', toUserId('user_projection'));
}

/** A corner-origin box 0..w × 0..10 × 0..5 whose width is parameter `w`. */
function block(width = 20) {
  const parameterized = setParameter(blank(), {
    name: 'w',
    expression: String(width)
  });
  const document = addPrimitiveFeature(parameterized, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 10, depth: 5 }
  });
  return { document, bodyId: document.bodyOrder.at(-1)! };
}

/** Top-face (z = 5) edges, in a stable order: by midpoint x, then y. */
function topEdges(derived: DerivedState, bodyId: BodyId): EdgeTopology[] {
  const edges = derived.bodyRepresentations[bodyId]?.topology?.edges ?? [];
  const mid = (edge: EdgeTopology) => {
    const n = edge.points.length;
    return {
      x: (edge.points[0]! + edge.points[n - 3]!) / 2,
      y: (edge.points[1]! + edge.points[n - 2]!) / 2,
      z: (edge.points[2]! + edge.points[n - 1]!) / 2
    };
  };
  return edges
    .filter((edge) => Math.abs(mid(edge).z - 5) < 1e-9)
    .sort((a, b) => mid(a).x - mid(b).x || mid(a).y - mid(b).y);
}

function projected(
  edge: EdgeTopology,
  bodyId: BodyId,
  mode: SketchProjectionMode,
  sketchBasis: PlaneBasis = basis
): SketchObjectData {
  const outcome = projectEdgeToSketch(
    projectableCurveFromTopology(edge),
    sketchBasis
  );
  if (outcome.status !== 'projected') throw new Error(outcome.reason);
  expect(edge.reference).toBeDefined();
  return {
    ...outcome.data,
    projection: { mode, source: { bodyId, edgeReference: edge.reference! } }
  };
}

function volumeOf(derived: DerivedState, bodyId: BodyId): number {
  return derived.bodyRepresentations[bodyId]!.volume;
}

describe('sketch projection in the document (v33)', () => {
  it('is additive, round-trips and refuses a malformed record', () => {
    const source = {
      bodyId: 'body_a' as BodyId,
      edgeReference: {
        kind: 'edge' as const,
        producingFeatureId: 'feat_a' as never,
        lineageName: 'edge:a',
        currentHash: 7,
        witnessVersion: 1 as const,
        witness: {
          curveType: 'LINE',
          length: 1,
          closed: false as const,
          endpoints: [
            [0, 0, 0],
            [1, 0, 0]
          ] as [[number, number, number], [number, number, number]],
          midpoint: [0, 0, 0] as [number, number, number]
        }
      }
    };
    source.edgeReference.currentHash = edgeTopologyWitnessHash(source.edgeReference.witness);
    const sketched = addSketchFeature(blank(), {
      name: 'S',
      planeRef: above,
      objects: [
        {
          objectKind: 'line',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 0,
          projection: { mode: 'linked', source }
        },
        {
          objectKind: 'circle',
          centerX: 0,
          centerY: 0,
          radius: 1,
          projection: { mode: 'unlinked' }
        }
      ]
    });
    const saved = JSON.parse(
      JSON.stringify(sketched.document)
    ) as ProjectDocument;
    expect(saved.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(normalizeDocument(saved)).toEqual(sketched.document);

    // A v30 document opens exactly as written: no projection is invented.
    type Version = typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
    const plain = addSketchFeature(blank(), {
      name: 'Plain',
      planeRef: above,
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }]
    }).document;
    const legacy = { ...plain, schemaVersion: 30 as Version };
    expect({
      ...normalizeDocument(structuredClone(legacy)),
      schemaVersion: 30
    }).toEqual(legacy);

    const objectOf = (mode: unknown, extra: object = {}) =>
      ({
        objectKind: 'line',
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 0,
        projection: { mode, ...extra }
      }) as unknown as SketchObjectData;
    const add = (object: SketchObjectData) =>
      addSketchObjects(sketched.document, {
        sketchId: sketched.sketchId,
        objects: [object]
      });
    expect(() => add(objectOf('linked'))).toThrow(/without a verified source/);
    expect(() => add(objectOf('mirrored', { source }))).toThrow(
      /expected "linked" or "unlinked"/
    );
    expect(() =>
      add({
        objectKind: 'polygon',
        sides: 6,
        radius: 1,
        centerX: 0,
        centerY: 0,
        projection: { mode: 'unlinked' }
      })
    ).toThrow(/only lines, arcs, circles and ellipses/);
    const corrupt = structuredClone(saved);
    const lineId = findSketch(corrupt, sketched.sketchId)!.objectIds[0]!;
    const node = corrupt.nodes[lineId]!;
    if (node.kind === 'sketch-object') {
      (node.data as { projection?: unknown }).projection = { mode: 'linked' };
    }
    expect(() => normalizeDocument(corrupt)).toThrow(
      /without a verified source/
    );
    // A witness that only looks like one is refused on load too, not left
    // for the exact build to trip over.
    for (const witness of [
      {},
      { ...source.edgeReference.witness, curveType: '' },
      { ...source.edgeReference.witness, length: 0.5 },
      { ...source.edgeReference.witness, endpoints: [[0, 0, 0]] },
      { curveType: 'CIRCLE', length: 1, closed: true, center: [0, 0] }
    ]) {
      expect(() =>
        add(
          objectOf('linked', {
            source: {
              ...source,
              edgeReference: { ...source.edgeReference, witness }
            }
          })
        )
      ).toThrow(/without a verified source/);
    }
    expect(() =>
      add(
        objectOf('linked', {
          source: {
            ...source,
            edgeReference: { ...source.edgeReference, currentHash: -1 }
          }
        })
      )
    ).toThrow(/without a verified source/);
  });
});

describe('sketch projection in the exact build', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** The block, a sketch above it with its top face projected, extruded 3. */
  async function projectedOutline(mode: SketchProjectionMode) {
    const { document, bodyId } = block();
    const derived = await adapter.syncDocument(document);
    const edges = topEdges(derived, bodyId);
    expect(edges).toHaveLength(4);
    const sketched = addSketchFeature(document, {
      name: 'Outline',
      planeRef: above,
      objects: edges.map((edge) => projected(edge, bodyId, mode))
    });
    const sketch = findSketch(sketched.document, sketched.sketchId)!;
    const extruded = extrudeSketch(sketched.document, {
      name: 'Plate',
      sketchId: sketched.sketchId,
      distance: 3,
      profiles: [{ all: true, sourceEntityIds: [...sketch.objectIds] }]
    });
    return {
      document: extruded.document,
      blockId: bodyId,
      plateId: extruded.bodyId,
      sketchId: sketched.sketchId,
      objectIds: [...sketch.objectIds]
    };
  }

  function writeBack(
    document: ProjectDocument,
    sketchId: SketchId,
    derived: DerivedState
  ): ProjectDocument {
    let next = document;
    for (const [objectId, state] of Object.entries(
      derived.sketchProjections ?? {}
    )) {
      if (state.status !== 'moved') continue;
      next = updateSketchObject(next, {
        sketchId,
        objectId: objectId as EntityId,
        data: state.data
      });
    }
    return next;
  }

  it('projects a new Boolean edge after an idle-skipped lineage rebuild', async () => {
    const source = block(40);
    const second = addPrimitiveFeature(source.document, { name: 'Post', primitiveKind: 'box', dimensions: { width: 12, height: 10, depth: 30 } });
    const fused = booleanBodies(second, { name: 'Fuse', operation: 'union', targetBodyIds: [source.bodyId, second.bodyOrder.at(-1)!] });
    const idle = await adapter.syncDocument(fused.document, undefined, undefined, undefined, { lineageDemand: [] });
    const topology = idle.bodyRepresentations[fused.bodyId]!.topology!;
    const candidate = topology.edges.find(edge => !edge.reference && edge.curve?.type === 'LINE' && Math.abs(edge.points[0]! - edge.points[3]!) > 1);
    expect(candidate, 'a new edge withheld by idle lineage mode').toBeDefined();
    let requests = 0;
    const pick = await projectionFromPickWithLineage({ document: { ...fused.document, derived: idle }, sketch: null, selection: { bodyId: fused.bodyId, kind: 'edge', hash: candidate!.hash, topologyId: candidate!.topologyId }, basis, mode: 'linked', construction: false }, {
      cancelled: () => false,
      rebuildWithLineage: async () => {
        requests++;
        const derived = await adapter.syncDocument(fused.document, undefined, undefined, undefined, { lineageDemand: [fused.bodyId] });
        return { ...fused.document, derived };
      }
    });
    expect(requests).toBe(1);
    expect(pick?.objects).toHaveLength(1);
    expect(pick?.objects[0]?.projection).toMatchObject({ mode: 'linked', source: { bodyId: fused.bodyId } });
  });

  it.each(['cached', 'cold reopen'] as const)(
    'resolves a saved new Boolean edge with empty selection demand: %s',
    async (cacheMode) => {
      const source = block(40);
      const second = addPrimitiveFeature(source.document, {
        name: 'Post',
        primitiveKind: 'box',
        dimensions: { width: 12, height: 10, depth: 30 }
      });
      const fused = booleanBodies(second, {
        name: 'Fuse',
        operation: 'union',
        targetBodyIds: [source.bodyId, second.bodyOrder.at(-1)!]
      });
      const producer = listFeaturesInOrder(fused.document).find(
        (feature) => feature.data.featureKind === 'boolean'
      )!;
      const idle = await adapter.syncDocument(
        fused.document,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [] }
      );
      const idleEdges = idle.bodyRepresentations[fused.bodyId]!.topology!.edges;
      const demanded = await adapter.syncDocument(
        fused.document,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [fused.bodyId] }
      );
      const edge = demanded.bodyRepresentations[
        fused.bodyId
      ]!.topology!.edges.find(
        (candidate) =>
          candidate.reference?.producingFeatureId === producer.featureId &&
          candidate.curve?.type === 'LINE' &&
          Math.abs(candidate.points[0]! - candidate.points[3]!) > 1 &&
          idleEdges.some(
            (original) =>
              original.hash === candidate.hash && !original.reference
          )
      );
      expect(
        edge,
        'new Boolean edge unavailable from carrier-only lineage'
      ).toBeDefined();
      const object = projected(edge!, fused.bodyId, 'linked');
      const sketched = addSketchFeature(fused.document, {
        name: 'Saved Boolean edge',
        planeRef: above,
        objects: [object]
      });
      const objectId = findSketch(sketched.document, sketched.sketchId)!
        .objectIds[0]!;
      const reopened = normalizeDocument(
        JSON.parse(JSON.stringify(sketched.document)) as ProjectDocument
      );
      const before = JSON.stringify(reopened);
      // Restore a carrier-only cache, then introduce the persisted consumer;
      // the other arm starts a completely new adapter with no UI selection.
      await adapter.syncDocument(
        fused.document,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [] }
      );
      const reader =
        cacheMode === 'cold reopen'
          ? await createExactKernelAdapter()
          : adapter;
      try {
        const result = await reader.syncDocument(
          reopened,
          undefined,
          undefined,
          undefined,
          { lineageDemand: [] }
        );
        expect(result.sketchProjections?.[objectId]).toEqual({
          status: 'current'
        });
        expect(result.warnings).toEqual([]);
        expect(result.bodyRepresentations[fused.bodyId]!.volume).toBeCloseTo(
          5000,
          6
        );
        expect(
          result.bodyRepresentations[fused.bodyId]!.topology!.edges.find(
            (candidate) => candidate.hash === edge!.hash
          )?.reference
        ).toEqual(edge!.reference);
        expect(JSON.stringify(reopened)).toBe(before);
      } finally {
        if (reader !== adapter) reader.dispose();
      }
    }
  );

  it('re-projects exactly what a pick stored, so nothing is rewritten', async () => {
    const outline = await projectedOutline('linked');
    const derived = await adapter.syncDocument(outline.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.sketchProjections).toEqual(
      Object.fromEntries(
        outline.objectIds.map((id) => [id, { status: 'current' }])
      )
    );
    expect(volumeOf(derived, outline.plateId)).toBeCloseTo(20 * 10 * 3, 6);
  });

  it('follows an upstream resize in the same rebuild, then settles', async () => {
    const outline = await projectedOutline('linked');
    const resized = setParameter(outline.document, {
      name: 'w',
      expression: '32'
    });
    const derived = await adapter.syncDocument(resized);
    // The plate follows the wider block at once: the build used the
    // re-projected edges, not the stored ones.
    expect(volumeOf(derived, outline.plateId)).toBeCloseTo(32 * 10 * 3, 6);
    const states = derived.sketchProjections ?? {};
    const moved = Object.entries(states).filter(
      ([, state]) => state.status === 'moved'
    );
    // The edge at x = w moves; the two spanning it stretch; x = 0 stays.
    expect(moved).toHaveLength(3);
    expect(
      Object.values(states).filter((state) => state.status === 'current')
    ).toHaveLength(1);
    const xs = moved.flatMap(([, state]) =>
      state.status === 'moved' && state.data.objectKind === 'line'
        ? [state.data.x1, state.data.x2]
        : []
    );
    expect(Math.max(...(xs as number[]))).toBeCloseTo(32, 9);
    for (const [, state] of moved) {
      if (state.status !== 'moved') continue;
      expect(state.data.projection?.mode).toBe('linked');
    }

    // Written back, the next rebuild finds every projection current.
    const settled = writeBack(resized, outline.sketchId, derived);
    const again = await adapter.syncDocument(settled);
    expect(
      Object.values(again.sketchProjections ?? {}).every(
        (state) => state.status === 'current'
      )
    ).toBe(true);
    expect(volumeOf(again, outline.plateId)).toBeCloseTo(32 * 10 * 3, 6);
  });

  it('exports fresh linked geometry before browser write-back in both SVG and DXF', async () => {
    const outline = await projectedOutline('linked');
    const resized = setParameter(outline.document, {
      name: 'w',
      expression: '32'
    });
    const savedNodes = JSON.stringify(resized.nodes);
    const built = await adapter.syncDocument(resized);
    const settled = writeBack(resized, outline.sketchId, built);
    const expectedSvg = await adapter.exportSketchSvg(
      settled,
      outline.sketchId
    );
    const expectedDxf = await adapter.exportSketchDxf(
      settled,
      outline.sketchId
    );
    expect(await adapter.exportSketchSvg(resized, outline.sketchId)).toBe(
      expectedSvg
    );
    expect(await adapter.exportSketchDxf(resized, outline.sketchId)).toBe(
      expectedDxf
    );
    expect(JSON.stringify(resized.nodes)).toBe(savedNodes);
  });

  it('keeps the line ends named when an edge comes back reversed', async () => {
    const outline = await projectedOutline('linked');
    // Store one line with its ends swapped: the re-projection must keep
    // that order rather than report a move.
    const id = outline.objectIds[0]!;
    const node = outline.document.nodes[id]!;
    if (node.kind !== 'sketch-object' || node.data.objectKind !== 'line') {
      throw new Error('expected a projected line');
    }
    const reversed = updateSketchObject(outline.document, {
      sketchId: outline.sketchId,
      objectId: id,
      data: {
        ...node.data,
        x1: node.data.x2,
        y1: node.data.y2,
        x2: node.data.x1,
        y2: node.data.y1
      }
    });
    const derived = await adapter.syncDocument(reversed);
    expect(derived.sketchProjections?.[id]).toEqual({ status: 'current' });
  });

  it('never moves an unlinked copy, and does not report it', async () => {
    const outline = await projectedOutline('unlinked');
    const resized = setParameter(outline.document, {
      name: 'w',
      expression: '32'
    });
    const derived = await adapter.syncDocument(resized);
    expect(derived.sketchProjections).toBeUndefined();
    expect(volumeOf(derived, outline.plateId)).toBeCloseTo(20 * 10 * 3, 6);
  });

  it('shows a deleted source as broken and keeps the last valid sketch', async () => {
    const outline = await projectedOutline('linked');
    const resized = writeBack(
      setParameter(outline.document, { name: 'w', expression: '25' }),
      outline.sketchId,
      await adapter.syncDocument(
        setParameter(outline.document, { name: 'w', expression: '25' })
      )
    );
    const blockFeature = listFeaturesInOrder(resized).find(
      (feature) => feature.name === 'Block'
    )!;
    const deleted = deleteFeature(resized, {
      featureId: blockFeature.featureId
    });
    const derived = await adapter.syncDocument(deleted);
    const states = Object.values(derived.sketchProjections ?? {});
    expect(states).toHaveLength(4);
    for (const state of states) {
      expect(state.status).toBe('broken');
      if (state.status === 'broken') {
        expect(state.reason).toMatch(/source body is unavailable/);
      }
    }
    // The last valid (w = 25) outline still builds the plate.
    expect(volumeOf(derived, outline.plateId)).toBeCloseTo(25 * 10 * 3, 6);
    const advisories = (derived.featureWarnings ?? []).filter((warning) =>
      /Projected line .* is broken/.test(warning.message)
    );
    expect(advisories).toHaveLength(4);
    expect(advisories.every((warning) => warning.kind === 'advisory')).toBe(
      true
    );
  });

  it('breaks by name when the edge was consumed, without guessing', async () => {
    // A second block drawn after the sketch is not the source: the edge
    // exists only through the first block's lineage.
    const outline = await projectedOutline('linked');
    const id = outline.objectIds[0]!;
    const node = outline.document.nodes[id]!;
    if (node.kind !== 'sketch-object' || !node.data.projection) {
      throw new Error('expected a projected object');
    }
    const projection = node.data.projection;
    if (projection.mode !== 'linked') throw new Error('expected linked');
    const orphaned = updateSketchObject(outline.document, {
      sketchId: outline.sketchId,
      objectId: id,
      data: {
        ...node.data,
        projection: {
          mode: 'linked',
          source: {
            ...projection.source,
            edgeReference: {
              ...projection.source.edgeReference,
              lineageName: `${projection.source.edgeReference.lineageName}.gone`
            }
          }
        }
      }
    });
    const derived = await adapter.syncDocument(orphaned);
    const state = derived.sketchProjections?.[id];
    expect(state?.status).toBe('broken');
    if (state?.status === 'broken') {
      expect(state.reason).toMatch(/deleted or no longer exists|fingerprint/);
    }
    expect(volumeOf(derived, outline.plateId)).toBeCloseTo(20 * 10 * 3, 6);
  });

  it('reads the edge at the sketch’s place in the history, not the end', async () => {
    // A sketch that comes before its source block cannot see the edge: it
    // is reported broken, never resolved against the later model.
    const source = block();
    const derived = await adapter.syncDocument(source.document);
    const [edge] = topEdges(derived, source.bodyId);
    const early = addSketchFeature(
      setParameter(blank(), { name: 'w', expression: '20' }),
      {
        name: 'Early',
        planeRef: above,
        objects: [projected(edge!, source.bodyId, 'linked')]
      }
    );
    const later = addPrimitiveFeature(early.document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'w', height: 10, depth: 5 },
      ids: {
        featureId: listFeaturesInOrder(source.document).at(-1)!.featureId,
        featureNodeId: listFeaturesInOrder(source.document).at(-1)!.id,
        bodyId: source.bodyId,
        bodyNodeId: Object.values(source.document.nodes).find(
          (node) => node.kind === 'body'
        )!.id
      }
    });
    const built = await adapter.syncDocument(later);
    const [objectId] = findSketch(later, early.sketchId)!.objectIds;
    const state = built.sketchProjections?.[objectId!];
    expect(state?.status).toBe('broken');
    if (state?.status === 'broken') {
      expect(state.reason).toMatch(/unavailable at the sketch's place/);
    }
  });

  it('breaks on a body a Boolean consumed before the sketch', async () => {
    // The block's edges still sit in the build's shapes once a union has
    // consumed it; they are not part of the model there and must not project.
    const source = block();
    const derived = await adapter.syncDocument(source.document);
    const [edge] = topEdges(derived, source.bodyId);
    const second = addPrimitiveFeature(source.document, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 4, depth: 4 }
    });
    const fused = booleanBodies(second, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [source.bodyId, second.bodyOrder.at(-1)!]
    });
    const sketched = addSketchFeature(fused.document, {
      name: 'After',
      planeRef: above,
      objects: [projected(edge!, source.bodyId, 'linked')]
    });
    const built = await adapter.syncDocument(sketched.document);
    const [objectId] = findSketch(
      sketched.document,
      sketched.sketchId
    )!.objectIds;
    const state = built.sketchProjections?.[objectId!];
    expect(state?.status).toBe('broken');
    if (state?.status === 'broken') {
      expect(state.reason).toMatch(/consumed by a feature before the sketch/);
    }
  });

  it('holds a linked ellipse whole in the solver', async () => {
    // A free ellipse made equal to a linked one takes the linked one's
    // radii; the linked one keeps its centre, semiaxes and rotation.
    const linked = {
      objectKind: 'ellipse' as const,
      centerX: 0,
      centerY: 0,
      radiusX: 10,
      radiusY: 4,
      rotationDeg: 20,
      projection: {
        mode: 'linked' as const,
        source: {
          bodyId: 'body_any' as BodyId,
          edgeReference: {
            kind: 'edge' as const,
            producingFeatureId: 'feat_any' as never,
            lineageName: 'edge.any',
            currentHash: 1,
            witnessVersion: 1 as const,
            witness: {
              curveType: 'CIRCLE',
              length: 1,
              closed: true as const,
              center: [0, 0, 0] as [number, number, number],
              axis: null
            }
          }
        }
      }
    };
    linked.projection.source.edgeReference.currentHash = edgeTopologyWitnessHash(linked.projection.source.edgeReference.witness);
    const sketched = addSketchFeature(blank(), {
      name: 'Solve',
      planeRef: above,
      objects: [
        linked,
        {
          objectKind: 'ellipse',
          centerX: 30,
          centerY: 0,
          radiusX: 6,
          radiusY: 5,
          rotationDeg: 0
        }
      ]
    });
    const [a, b] = findSketch(sketched.document, sketched.sketchId)!.objectIds;
    const { document: constrained } = addSketchConstraint(sketched.document, {
      sketchId: sketched.sketchId,
      constraint: {
        constraintKind: 'equal',
        a: a!,
        b: b!
      }
    });
    const outcome = await adapter.solveSketch(constrained, sketched.sketchId);
    expect(outcome.converged).toBe(true);
    const [held, free] = outcome.objects as {
      radiusX: number;
      radiusY: number;
      rotationDeg: number;
      centerX: number;
    }[];
    expect(held!.radiusX).toBeCloseTo(10, 8);
    expect(held!.radiusY).toBeCloseTo(4, 8);
    expect(held!.rotationDeg).toBeCloseTo(20, 8);
    expect(held!.centerX).toBeCloseTo(0, 8);
    expect(free!.radiusX).toBeCloseTo(10, 6);
    expect(free!.radiusY).toBeCloseTo(4, 6);
  });

  it('projects a cylinder rim as an exact circle', async () => {
    const document = addPrimitiveFeature(blank(), {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 6 }
    });
    const bodyId = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    const rims = (derived.bodyRepresentations[bodyId]?.topology?.edges ?? [])
      .filter((edge) => edge.curve?.type === 'CIRCLE' && edge.reference)
      .slice(0, 1);
    expect(rims).toHaveLength(1);
    const circle = projected(rims[0]!, bodyId, 'linked');
    expect(circle).toMatchObject({ objectKind: 'circle' });
    if (circle.objectKind === 'circle') {
      expect(circle.radius).toBeCloseTo(4, 9);
    }
    const sketched = addSketchFeature(document, {
      name: 'Rim',
      planeRef: above,
      objects: [circle]
    });
    const again = await adapter.syncDocument(sketched.document);
    const [objectId] = findSketch(
      sketched.document,
      sketched.sketchId
    )!.objectIds;
    expect(again.sketchProjections?.[objectId!]).toEqual({ status: 'current' });
  });
});
