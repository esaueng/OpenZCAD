import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  findSketch,
  importStepBody,
  listFeaturesInOrder,
  moveFeature,
  patternBody,
  setParameter,
  transformBody,
  updateFeature,
  withoutDerivedProjection,
  type ExtrudeInput
} from '@openzcad/document-core';
import type {
  ExactKernelAdapter,
  ExactKernelAdapterOptions,
  RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ExtrudeToFaceTarget,
  type FeatureId,
  type ProjectDocument,
  type SketchPlaneRef
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  sameStructure
} from './perf/h02-session-exact';
import {
  captureExactArenas,
  compareExactArenas
} from './support/exact-arena-equivalence';
import * as evolution from '../packages/kernel-adapter/src/exact-boolean-evolution';
import {
  loadRemusTranslators,
  RemusKernel
} from '../packages/kernel-adapter/src/remus-runtime';
import type { HistoryCheckpointEntry } from '../packages/kernel-adapter/src/exact-history-cache';
import { IdleLineageViewBuilder } from '../packages/kernel-adapter/src/exact-idle-lineage-view';
import { recognizePlanarEmboss } from '../packages/kernel-adapter/src/planar-emboss';
import { letteredHolder } from './support/lettered-holder';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';

interface Equivalence {
  rawEquivalent: boolean;
  publicationEquivalent: boolean;
  publicationDifferences: {
    root: string[];
    bodies: { bodyIndex: number; count: number; paths: string[] }[];
  };
  bodies: number;
  serializedBytes: number;
  faces: number;
  warnings: number;
}

interface Probe {
  compareFresh(): Promise<Equivalence>;
}

interface Harness {
  adapter: ExactKernelAdapter;
  probe: Probe;
  events: RebuildCacheEvent[];
}

function cacheState(adapter: ExactKernelAdapter) {
  return adapter as unknown as {
    historyKernel: RemusKernel | null;
    historyCheckpoints: HistoryCheckpointEntry[];
    historyCheckpointOwners: Map<number, HistoryCheckpointEntry>;
    historyLineageMetadataBytes: number;
    measuredShapeCache: Map<BodyId, { bytes: number }>;
    measuredShapeCacheBytes: number;
  };
}

function assertLineageOwners(adapter: ExactKernelAdapter) {
  const state = cacheState(adapter);
  expect(state.historyLineageMetadataBytes).toBe(
    state.historyCheckpoints.reduce(
      (bytes, entry) => bytes + (entry.lineageMetadataBytes ?? 0),
      0
    )
  );
  expect(state.historyLineageMetadataBytes).toBeLessThanOrEqual(
    128 * 1024 * 1024
  );
  for (const entry of state.historyCheckpoints) {
    expect(state.historyCheckpointOwners.get(entry.checkpointId)).toBe(entry);
    const primaryBytes = new TextEncoder().encode(
      entry.lineageProbeKey ?? ''
    ).byteLength;
    expect(entry.lineageMetadataBytes ?? 0).toBeGreaterThanOrEqual(
      primaryBytes + (entry.idleLineageView?.estimatedBytes ?? 0)
    );
    const view = entry.idleLineageView;
    if (!view) continue;
    expect(view.estimatedBytes).toBeGreaterThan(0);
    expect(view.digests).toHaveLength(entry.featureIndex + 1);
    expect(view.state.diverged).toBe(true);
    for (const [bodyId, lineage] of view.state.lineages) {
      const shape = entry.snapshot.shapes.get(bodyId);
      expect(shape).toBeDefined();
      if (!lineage) continue;
      const faces = new Set(
        shape!.solids.flatMap((solid) =>
          Array.from(state.historyKernel!.getSolidFaces(solid))
        )
      );
      const edges = new Set(
        shape!.solids.flatMap((solid) =>
          Array.from(state.historyKernel!.getSolidEdges(solid))
        )
      );
      for (const face of lineage.faceReferences.keys())
        expect(faces.has(face)).toBe(true);
      for (const edge of lineage.edgeReferences.keys())
        expect(edges.has(edge)).toBe(true);
    }
  }
}

async function harness(
  options: ExactKernelAdapterOptions = {}
): Promise<Harness> {
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    ...options,
    onRebuildCacheEvent: (event) => events.push(event)
  });
  return {
    adapter,
    events,
    probe: (globalThis as unknown as { __h02Session: Probe }).__h02Session
  };
}

function fusedPlateDocument(
  document = createProjectDocument(
    'Lineage mode qualification',
    toUserId('test')
  )
) {
  let next = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 24, depth: 10 }
  });
  const plate = next.bodyOrder.at(-1)!;
  next = addPrimitiveFeature(next, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 12, height: 24, depth: 30 }
  });
  return booleanBodies(next, {
    name: 'Fuse',
    operation: 'union',
    targetBodyIds: [plate, next.bodyOrder.at(-1)!]
  });
}

/** Entirely generated, redistributable STEP; no private source is read. */
async function importedTextTailDocument(
  options: Pick<
    ExtrudeInput,
    'draftAngleDeg' | 'symmetric' | 'backDistance'
  > = {}
) {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  try {
    const step = io.exportStep(
      kernel.serializeSolids(Uint32Array.of(letteredHolder(kernel)))
    );
    const solids = kernel.deserializeSolids(io.importStep(step));
    expect(solids).toHaveLength(1);
    const selection = recognizePlanarEmboss(kernel, solids[0]!);
    expect(selection).not.toBeNull();
    if (!selection) throw new Error('Public planar emboss must be recognized.');
    const fused = fusedPlateDocument();
    const imported = importStepBody(fused.document, {
      name: 'Text',
      artifactId: 'public-generated-lettering',
      sourceName: 'public-generated-lettering.step',
      stepText: new TextDecoder().decode(step),
      planarEmboss: { part: 'text', selection }
    });
    const parameterized = setParameter(imported.document, {
      name: 'tail_height',
      expression: '10'
    });
    // A closed line region follows the same canonical-profile path as a
    // recipe bridge, independently of the earlier boolean's topology.
    const sketch = addSketchFeature(parameterized, {
      name: 'Independent bridge section',
      planeRef: {
        type: 'canonical',
        plane: 'XY',
        offset: 'tail_height / 10'
      },
      objects: [
        { objectKind: 'line', x1: 80, y1: 0, x2: 84, y2: 0 },
        { objectKind: 'line', x1: 84, y1: 0, x2: 84, y2: 3 },
        { objectKind: 'line', x1: 84, y1: 3, x2: 80, y2: 3 },
        { objectKind: 'line', x1: 80, y1: 3, x2: 80, y2: 0 }
      ]
    });
    const sketchNode = findSketch(sketch.document, sketch.sketchId)!;
    const regions = computeSketchRegions(
      sketchNode.objectIds.flatMap((id) => {
        const node = sketch.document.nodes[id];
        return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
      }),
      (value) => (typeof value === 'number' ? value : Number(value))
    );
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    const extruded = extrudeSketch(sketch.document, {
      name: 'Independent bridge',
      sketchId: sketch.sketchId,
      distance: 'tail_height',
      profile: {
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        sourceArea: region.area
      },
      ...options
    });
    return transformBody(extruded.document, {
      name: 'Dependent bridge move',
      targetBodyId: extruded.bodyId,
      translation: { x: 'tail_height / 5', y: 0, z: 0 }
    }).document;
  } finally {
    kernel.free();
  }
}

async function preparedBooleanTransformDocument(textBeforeBoolean = false) {
  const initial = await importedTextTailDocument();
  const text = listFeaturesInOrder(initial).find(
    (feature) => feature.name === 'Text'
  )!;
  const document = textBeforeBoolean
    ? moveFeature(initial, { featureId: text.featureId, toIndex: 2 })
    : initial;
  const boolean = listFeaturesInOrder(document).find(
    (feature) => feature.data.featureKind === 'boolean'
  )!;
  const transformed = transformBody(document, {
    name: 'Fixed earlier boolean placement',
    targetBodyId: boolean.bodyId!,
    translation: { x: 2, y: 3, z: 1 },
    rotationDeg: { x: 0, y: 0, z: 90 }
  }).document;
  const placement = listFeaturesInOrder(transformed).at(-1)!;
  // The edited bridge comes before this fixed transform, so its prefix
  // restore must retain the unchanged boolean's prepared geometry path.
  return moveFeature(transformed, {
    featureId: placement.featureId,
    toIndex: listFeaturesInOrder(document).length - 1
  });
}

async function boundExtrusionDocument(
  kind: 'datum-profile' | 'blind-cut' | 'through-all' | 'to-face'
) {
  let root = createProjectDocument('Bound extrusion', toUserId('test'));
  let datumFeatureId: FeatureId | undefined;
  if (kind === 'datum-profile') {
    const datum = addDatumPlane(root, {
      name: 'Earlier datum',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 1
      }
    });
    root = datum.document;
    datumFeatureId = datum.featureId;
  }
  const fused = fusedPlateDocument(root);
  let document = fused.document;
  let toFace: ExtrudeToFaceTarget | undefined;
  if (kind === 'to-face') {
    document = addPrimitiveFeature(document, {
      name: 'Independent ceiling',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 24, depth: 2 }
    });
    const ceilingId = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Lift ceiling',
      targetBodyId: ceilingId,
      translation: { x: 0, y: 0, z: 20 }
    }).document;
    const preparation = await harness();
    try {
      const built = await preparation.adapter.syncDocument(document);
      const face = built.bodyRepresentations[ceilingId]!.topology!.faces.find(
        (candidate) => (candidate.geometry?.normal?.z ?? 0) < -0.99
      )!;
      const attachment = faceSketchAttachment({
        bodyId: ceilingId,
        pickedHash: face.hash,
        face
      });
      if (!attachment.ok || attachment.attachment !== 'associative')
        throw new Error('Public ceiling must have an associative planar face.');
      toFace = attachment.planeRef as ExtrudeToFaceTarget;
    } finally {
      preparation.adapter.dispose();
    }
  }
  const planeRef: SketchPlaneRef = datumFeatureId
    ? { type: 'datum', datumFeatureId }
    : { type: 'canonical', plane: 'XY', offset: 0 };
  const sketch = addSketchFeature(document, {
    name: 'Bound section',
    planeRef,
    objects: [
      { objectKind: 'rectangle', width: 4, height: 4, centerX: 20, centerY: 12 }
    ]
  });
  return extrudeSketch(sketch.document, {
    name: 'Bound extrusion',
    sketchId: sketch.sketchId,
    distance: 4,
    ...(kind === 'blind-cut' || kind === 'through-all'
      ? { operation: 'cut' as const, targetBodyId: fused.bodyId }
      : {}),
    ...(kind === 'through-all'
      ? {
          endCondition: 'through-all' as const,
          throughAllSide: 'forward' as const
        }
      : {}),
    ...(toFace ? { endCondition: 'to-face' as const, toFace } : {})
  }).document;
}

function withoutTimestamp({ updatedAt: _time, ...derived }: DerivedState) {
  return derived;
}

/**
 * Compare the first response as well as a repeat, then use the unchanged H02
 * oracle against cache-disabled fresh geometry. No published fields are
 * removed beyond the oracle's established cross-arena normalization.
 */
async function qualify(
  { adapter, probe }: Harness,
  document: ProjectDocument,
  demand?: readonly BodyId[],
  context = 'Mode qualification',
  completedFeatures?: string[]
) {
  const options = demand === undefined ? undefined : { lineageDemand: demand };
  const sync = () =>
    adapter.syncDocument(
      document,
      completedFeatures
        ? (progress) => {
            if (progress.stage === 'feature' && progress.status === 'completed')
              completedFeatures.push(progress.name);
          }
        : undefined,
      undefined,
      undefined,
      options
    );
  const first = await captureExactArenas(adapter, document, sync);
  const repeated = await captureExactArenas(adapter, document, sync);
  expect(compareExactArenas(first.bodies, repeated.bodies).equivalent).toBe(
    true
  );
  expect(
    sameStructure(
      withoutTimestamp(first.result),
      withoutTimestamp(repeated.result)
    ),
    'The first mode-specific response must equal its repeat in the same arena'
  ).toBe(true);
  const fresh = await probe.compareFresh();
  expect(
    fresh.rawEquivalent,
    `${context}: every raw B-rep byte must match fresh`
  ).toBe(true);
  expect(
    fresh.publicationEquivalent,
    `${context}: every publication field under the unchanged oracle must match fresh`
  ).toBe(true);
  expect(fresh.publicationDifferences).toEqual({ root: [], bodies: [] });
  expect(fresh.bodies).toBe(document.bodyOrder.length);
  expect(fresh.faces).toBeGreaterThan(0);
  expect(fresh.serializedBytes).toBeGreaterThan(0);
  expect(fresh.warnings).toBe(0);
  return first.result;
}

afterEach(() => vi.restoreAllMocks());

describe('H02 mode-specific cached lineage', { timeout: 120_000 }, () => {
  it('matches fresh after eager-to-idle transitions without probing idle requests', async () => {
    const { document } = fusedPlateDocument();
    const subject = await harness();
    const probe = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
    try {
      await qualify(subject, document, []);
      expect(probe).not.toHaveBeenCalled();
      await qualify(subject, document);
      expect(probe).toHaveBeenCalled();
      probe.mockClear();
      await qualify(subject, document, []);
      expect(probe).not.toHaveBeenCalled();
      await qualify(subject, document);
      subject.adapter.dispose();
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('charges finalized lineage metadata to its live checkpoint and clears it on disposal', async () => {
    const { document } = fusedPlateDocument();
    const subject = await harness();
    try {
      await qualify(subject, document);
      expect(
        cacheState(subject.adapter).historyCheckpoints.some(
          (entry) => entry.idleLineageView !== undefined
        )
      ).toBe(true);
      expect(
        cacheState(subject.adapter).historyLineageMetadataBytes
      ).toBeGreaterThan(0);
      assertLineageOwners(subject.adapter);
      await qualify(subject, document, []);
      assertLineageOwners(subject.adapter);
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      expect(cacheState(subject.adapter).historyCheckpointOwners.size).toBe(0);
      await qualify(subject, document, []);
      assertLineageOwners(subject.adapter);
    } finally {
      subject.adapter.dispose();
    }
  });

  it.each([
    { historyCheckpointLimit: 0 },
    { historyCheckpointEstimatedBytes: 0 }
  ])(
    'does not build alternate views when retention is disabled by %o',
    async (options) => {
      const { document } = fusedPlateDocument();
      const subject = await harness(options);
      const tracker = vi.spyOn(IdleLineageViewBuilder.prototype, 'begin');
      const probe = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
      try {
        await qualify(subject, document);
        probe.mockClear();
        await qualify(subject, document, []);
        expect(probe).not.toHaveBeenCalled();
        expect(tracker).not.toHaveBeenCalled();
        expect(cacheState(subject.adapter).historyCheckpoints).toHaveLength(0);
        expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
        subject.adapter.dispose();
        expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      } finally {
        subject.adapter.dispose();
      }
    }
  );

  it('keeps two independent boolean results distinct under partial-demand swaps', async () => {
    const first = fusedPlateDocument();
    const second = fusedPlateDocument(first.document);
    const subject = await harness();
    try {
      for (const demand of [
        undefined,
        [first.bodyId],
        [second.bodyId],
        [first.bodyId, second.bodyId],
        [],
        [second.bodyId],
        []
      ])
        await qualify(subject, second.document, demand);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('publishes fresh lineage on an eleven-feature preview release without replay or idle probes', async () => {
    let { document } = fusedPlateDocument();
    for (let index = 0; index < 4; index++) {
      document = addPrimitiveFeature(document, {
        name: `Tag ${index}`,
        primitiveKind: 'box',
        dimensions: { width: 4, height: 4, depth: 4 }
      });
      document = transformBody(document, {
        name: `Move tag ${index}`,
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x: 60 + index * 6, y: 0, z: 0 }
      }).document;
    }
    const last = listFeaturesInOrder(document).at(-1)!;
    if (last.data.featureKind !== 'transform')
      throw new Error('Missing tail move');
    const dragged = updateFeature(document, {
      featureId: last.featureId,
      data: {
        transform: {
          ...last.data.transform,
          translation: { x: 90, y: 0, z: 0 }
        }
      }
    });
    const subject = await harness();
    const probe = vi.spyOn(evolution, 'probeBooleanEntityEvolution');
    try {
      await subject.adapter.syncDocument(
        document,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [] }
      );
      await subject.adapter.previewGeometry(dragged);
      probe.mockClear();
      const releaseEvent = subject.events.length;
      await qualify(subject, dragged, []);
      expect(subject.events[releaseEvent]).toMatchObject({
        restored: 11,
        replayed: 0
      });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      subject.adapter.dispose();
    }
  });

  it('carries the requested mode through rigid transforms and ancestor booleans', async () => {
    const fused = fusedPlateDocument();
    let document = transformBody(fused.document, {
      name: 'Move fused body',
      targetBodyId: fused.bodyId,
      translation: { x: 3, y: 0, z: 0 }
    }).document;
    document = addPrimitiveFeature(document, {
      name: 'Later operand',
      primitiveKind: 'box',
      dimensions: { width: 8, height: 8, depth: 8 }
    });
    const descendant = booleanBodies(document, {
      name: 'Subtract later operand',
      operation: 'subtract',
      targetBodyIds: [fused.bodyId, document.bodyOrder.at(-1)!]
    });
    document = transformBody(descendant.document, {
      name: 'Move descendant',
      targetBodyId: descendant.bodyId,
      translation: { x: 0, y: 4, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;
    const subject = await harness();
    try {
      for (const demand of [
        undefined,
        [],
        [descendant.bodyId],
        [],
        [fused.bodyId],
        []
      ])
        await qualify(subject, document, demand);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('resolves persisted boolean edge consumers after switching publication modes', async () => {
    const { document, bodyId } = fusedPlateDocument();
    const subject = await harness();
    try {
      await qualify(subject, document);
      await qualify(subject, document, []);
      const demanded = await qualify(subject, document, [bodyId]);
      const edge = demanded.bodyRepresentations[bodyId]!.topology!.edges.find(
        (candidate) =>
          candidate.reference?.lineageName.startsWith('boolean.edge.')
      );
      expect(edge?.reference).toBeDefined();
      const rounded = filletEdges(document, {
        name: 'Persisted round',
        targetBodyId: bodyId,
        edgeHashes: [edge!.hash],
        edgeReferences: [edge!.reference!],
        size: 1
      }).document;
      const feature = listFeaturesInOrder(rounded).at(-1)!;
      expect(feature.data.featureKind).toBe('fillet');
      const persisted = JSON.parse(
        JSON.stringify(withoutDerivedProjection(rounded))
      ) as ProjectDocument;
      await qualify(subject, persisted, []);
      await qualify(subject, persisted);
      subject.adapter.dispose();
      await qualify(subject, persisted, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('replays an unsupported lineage-view tail instead of publishing an eager pattern as idle', async () => {
    const fused = fusedPlateDocument();
    const patterned = patternBody(fused.document, {
      name: 'Pattern of fused body',
      targetBodyId: fused.bodyId,
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 60
    });
    const subject = await harness();
    try {
      const coldIdle = await harness();
      try {
        await qualify(
          coldIdle,
          patterned.document,
          [],
          'Pattern cold idle control'
        );
      } finally {
        coldIdle.adapter.dispose();
      }
      for (const [phase, demand] of [
        undefined,
        [],
        [patterned.bodyId],
        [],
        undefined
      ].entries()) {
        const requestedEvent = subject.events.length;
        await qualify(
          subject,
          patterned.document,
          demand,
          `Pattern phase ${phase}`
        );
        if (phase === 1)
          expect(subject.events[requestedEvent]).toMatchObject({
            kind: 'full-rebuild',
            restored: 0,
            replayed: listFeaturesInOrder(patterned.document).length,
            measurementCache: { resetReason: null }
          });
      }
    } finally {
      subject.adapter.dispose();
    }
  });

  it('rebuilds a reference-bound axis rotation in a fresh arena when lineage mode changes', async () => {
    // The datum precedes the boolean so only the axis-bound Move is the
    // unaudited suffix. A generic transform whitelist must not admit it.
    const axis = addDatumAxis(
      createProjectDocument('Axis-mode qualification', toUserId('test')),
      {
        name: 'Turn axis',
        definition: {
          kind: 'two-point',
          points: [
            { type: 'point', point: { x: 10, y: 0, z: 0 } },
            { type: 'point', point: { x: 10, y: 0, z: 1 } }
          ]
        }
      }
    );
    const fused = fusedPlateDocument(axis.document);
    const turned = transformBody(fused.document, {
      name: 'Turn about datum',
      targetBodyId: fused.bodyId,
      translation: { x: 0, y: 0, z: 5 },
      axisRotation: {
        axis: { type: 'datum-axis', datumFeatureId: axis.featureId },
        angleDeg: 90
      }
    });
    const subject = await harness();
    try {
      const coldIdle = await harness();
      try {
        await qualify(coldIdle, turned.document, [], 'Axis cold idle control');
      } finally {
        coldIdle.adapter.dispose();
      }
      for (const [phase, demand] of [
        undefined,
        [],
        undefined,
        [],
        [turned.bodyId]
      ].entries()) {
        const requestedEvent = subject.events.length;
        await qualify(subject, turned.document, demand, `Axis phase ${phase}`);
        if (phase === 1)
          expect(subject.events[requestedEvent]).toMatchObject({
            kind: 'full-rebuild',
            restored: 0,
            replayed: listFeaturesInOrder(turned.document).length,
            measurementCache: { resetReason: null }
          });
      }
    } finally {
      subject.adapter.dispose();
    }
  });

  it.each(['throws', 'disagrees'] as const)(
    'keeps declined evolution evidence mode-specific when its probe %s',
    async (failure) => {
      const { document, bodyId } = fusedPlateDocument();
      const original = RemusKernel.prototype.fuseWithEntityEvolution;
      const fault = vi
        .spyOn(RemusKernel.prototype, 'fuseWithEntityEvolution')
        .mockImplementation(function (this: RemusKernel, left, right) {
          if (failure === 'throws')
            throw new Error('Injected evolution failure');
          const payload = JSON.parse(
            original.call(this, left, right)
          ) as Record<string, unknown>;
          // Keep the payload but deliberately make it describe another solid.
          // The plain boolean geometry must still be the one that ships.
          payload.solid = this.makeBox(1, 1, 1);
          return JSON.stringify(payload);
        });
      const subject = await harness();
      try {
        const eager = await qualify(subject, document);
        expect(fault).toHaveBeenCalled();
        expect(
          eager.bodyRepresentations[bodyId]!.topology!.lineageDiagnostics!.some(
            (entry) =>
              entry.message.includes(
                failure === 'throws'
                  ? 'Injected evolution failure'
                  : 'did not reproduce the body'
              )
          )
        ).toBe(true);
        for (const demand of [[], [bodyId], [], undefined]) {
          const result = await qualify(subject, document, demand);
          expect(
            result.bodyRepresentations[bodyId]!.topology!.edges.some((edge) =>
              edge.reference?.lineageName.startsWith('boolean.edge.')
            )
          ).toBe(false);
        }
      } finally {
        subject.adapter.dispose();
        fault.mockRestore();
      }
    }
  );

  it('drops evicted lineage views and measurements under the existing cache budgets', async () => {
    const fused = fusedPlateDocument();
    let document = fused.document;
    const bodyId = fused.bodyId;
    for (let index = 0; index < 6; index++)
      document = addPrimitiveFeature(document, {
        name: `Pressure tag ${index}`,
        primitiveKind: 'box',
        dimensions: { width: 4, height: 4, depth: 4 }
      });
    const calibration = await harness();
    let budget: number;
    try {
      const modes = [];
      for (const demand of [undefined, []]) {
        await calibration.adapter.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          demand === undefined ? undefined : { lineageDemand: demand }
        );
        const sizes = [
          ...cacheState(calibration.adapter).measuredShapeCache.values()
        ].map((entry) => entry.bytes);
        expect(sizes).toHaveLength(document.bodyOrder.length);
        modes.push(sizes);
      }
      // Eager lineage is larger than idle lineage. Calibrate both modes so
      // neither can fit its entire working set, while every entry still fits.
      const total = Math.min(
        ...modes.map((sizes) => sizes.reduce((sum, bytes) => sum + bytes, 0))
      );
      const largest = Math.max(...modes.flat());
      budget = largest + Math.floor((total - largest) / 2);
      expect(budget).toBeGreaterThan(largest);
      expect(budget).toBeLessThan(total);
    } finally {
      calibration.adapter.dispose();
    }
    const subject = await harness({
      historyCheckpointLimit: 2,
      measuredShapeCacheBytes: budget
    });
    try {
      for (const demand of [undefined, [], [bodyId], [], undefined, []]) {
        await qualify(subject, document, demand);
        const state = cacheState(subject.adapter);
        assertLineageOwners(subject.adapter);
        expect(state.historyCheckpoints.length).toBeLessThanOrEqual(2);
        expect(state.historyCheckpointOwners.size).toBe(
          state.historyCheckpoints.length
        );
        expect(
          state.historyCheckpoints.every(
            (entry) =>
              state.historyCheckpointOwners.get(entry.checkpointId) === entry
          )
        ).toBe(true);
        expect(state.measuredShapeCache.size).toBeLessThan(
          document.bodyOrder.length
        );
        expect(state.measuredShapeCacheBytes).toBe(
          [...state.measuredShapeCache.values()].reduce(
            (sum, entry) => sum + entry.bytes,
            0
          )
        );
        expect(state.measuredShapeCacheBytes).toBeLessThanOrEqual(budget);
      }
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyCheckpointOwners.size).toBe(0);
      expect(cacheState(subject.adapter).measuredShapeCacheBytes).toBe(0);
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('keeps mode-specific lineage exact across real replay-budget recycling and restart', async () => {
    const fused = fusedPlateDocument();
    let document = transformBody(fused.document, {
      name: 'First dependent move',
      targetBodyId: fused.bodyId,
      translation: { x: 1, y: 0, z: 0 }
    }).document;
    const editedOperand = listFeaturesInOrder(fused.document)[1]!;
    document = transformBody(document, {
      name: 'Second dependent move',
      targetBodyId: fused.bodyId,
      translation: { x: 0, y: 2, z: 0 }
    }).document;
    const subject = await harness();
    try {
      await qualify(subject, document);
      await qualify(subject, document, []);
      const originalKernel = (
        subject.adapter as unknown as { historyKernel: RemusKernel }
      ).historyKernel;
      for (let edit = 0; edit < 270; edit++) {
        document = updateFeature(document, {
          featureId: editedOperand.featureId,
          data: {
            dimensions: { width: 12 + (edit % 2), height: 24, depth: 30 }
          }
        });
        const demand = edit % 2 ? undefined : [];
        const result = await subject.adapter.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          demand === undefined ? undefined : { lineageDemand: demand }
        );
        expect(result.warnings).toEqual([]);
        if (edit % 50 === 0) {
          await qualify(subject, document, demand);
          assertLineageOwners(subject.adapter);
        }
      }
      expect(
        subject.events.some((event) => event.recycleReason === 'replay-budget')
      ).toBe(true);
      expect(
        (subject.adapter as unknown as { historyKernel: RemusKernel })
          .historyKernel
      ).not.toBe(originalKernel);
      await qualify(subject, document, []);
      await qualify(subject, document);
      assertLineageOwners(subject.adapter);
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('restores fixed planar-emboss STEP text after a boolean across eager/idle transitions and the first real tail edit', async () => {
    let document = await importedTextTailDocument();
    const featureCount = listFeaturesInOrder(document).length;
    // Both cache-disabled modes independently establish that this public
    // fixture is stable under the unchanged strict serialization oracle.
    for (const demand of [undefined, []] as const) {
      const cold = await harness({
        historyCheckpointLimit: 0,
        importedStepCacheBytes: 0,
        measuredShapeCacheBytes: 0
      });
      try {
        const options =
          demand === undefined ? undefined : { lineageDemand: demand };
        await cold.adapter.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          options
        );
        await cold.adapter.syncDocument(
          document,
          undefined,
          undefined,
          undefined,
          options
        );
        const warmControl = await captureExactArenas(
          cold.adapter,
          document,
          () =>
            cold.adapter.syncDocument(
              document,
              undefined,
              undefined,
              undefined,
              options
            )
        );
        const freshControl = await harness({
          historyCheckpointLimit: 0,
          importedStepCacheBytes: 0,
          measuredShapeCacheBytes: 0
        });
        try {
          const freshCapture = await captureExactArenas(
            freshControl.adapter,
            document,
            () =>
              freshControl.adapter.syncDocument(
                document,
                undefined,
                undefined,
                undefined,
                options
              )
          );
          expect(
            compareExactArenas(warmControl.bodies, freshCapture.bodies)
          ).toMatchObject({ equivalent: true });
        } finally {
          freshControl.adapter.dispose();
        }
        await qualify(cold, document, demand, 'Public text cold control');
      } finally {
        cold.adapter.dispose();
      }
    }
    const subject = await harness();
    try {
      await qualify(subject, document);
      for (const demand of [[], undefined] as const) {
        const completed: string[] = [];
        const before = subject.events.length;
        await qualify(
          subject,
          document,
          demand,
          'Fixed text mode switch',
          completed
        );
        expect(subject.events[before]).toMatchObject({
          kind: 'prefix-restore',
          restored: featureCount,
          replayed: 0
        });
        expect(completed).not.toContain('Text');
      }
      document = setParameter(document, {
        name: 'tail_height',
        expression: '11'
      });
      const completed: string[] = [];
      const before = subject.events.length;
      await qualify(
        subject,
        document,
        [],
        'First actual bridge edit',
        completed
      );
      expect(subject.events[before]).toMatchObject({
        kind: 'prefix-restore',
        restored: 4,
        replayed: 3
      });
      expect(completed).not.toContain('Text');
      expect(completed).toContain('Independent bridge section');
      expect(completed).toContain('Independent bridge');
      expect(completed).toContain('Dependent bridge move');
      assertLineageOwners(subject.adapter);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('crosses the unchanged replay budget with imported text and real independent bridge edits instead of avoiding recycling through fresh rebuilds', async () => {
    let document = await importedTextTailDocument();
    const subject = await harness();
    const editEvents: RebuildCacheEvent[] = [];
    let textExecutionsOutsideRecycling = 0;
    try {
      await qualify(subject, document);
      const originalKernel = cacheState(subject.adapter).historyKernel;
      for (let edit = 0; edit < 180; edit++) {
        document = setParameter(document, {
          name: 'tail_height',
          expression: String(11 + edit / 10)
        });
        const completed: string[] = [];
        const demand = edit % 2 ? undefined : [];
        const result = await subject.adapter.syncDocument(
          document,
          (progress) => {
            if (progress.stage === 'feature' && progress.status === 'completed')
              completed.push(progress.name);
          },
          undefined,
          undefined,
          demand === undefined ? undefined : { lineageDemand: demand }
        );
        expect(result.warnings).toEqual([]);
        const event = subject.events.at(-1)!;
        editEvents.push(event);
        if (event.recycleReason !== 'replay-budget')
          textExecutionsOutsideRecycling += completed.filter(
            (name) => name === 'Text'
          ).length;
        if (edit % 45 === 0 || event.recycleReason === 'replay-budget') {
          await qualify(
            subject,
            document,
            demand,
            'Sustained public text edit'
          );
          assertLineageOwners(subject.adapter);
        }
      }
      expect(
        editEvents.filter((event) => event.recycleReason === 'replay-budget')
          .length,
        'Real bridge replay must cross the unchanged replay recycling budget'
      ).toBeGreaterThan(0);
      expect(
        editEvents.filter(
          (event) => event.kind === 'full-rebuild' && !event.recycleReason
        )
      ).toEqual([]);
      expect(textExecutionsOutsideRecycling).toBe(0);
      for (const event of editEvents) {
        expect(event).toMatchObject(
          event.recycleReason === 'replay-budget'
            ? { kind: 'full-rebuild', restored: 0, replayed: 7 }
            : { kind: 'prefix-restore', restored: 4, replayed: 3 }
        );
      }
      expect(cacheState(subject.adapter).historyKernel).not.toBe(
        originalKernel
      );
      await qualify(subject, document, []);
      await qualify(subject, document);
      assertLineageOwners(subject.adapter);
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });

  it.each(['datum-profile', 'blind-cut', 'through-all', 'to-face'] as const)(
    'keeps %s extrusion dependencies on the strict fresh fallback path',
    async (kind) => {
      const document = await boundExtrusionDocument(kind);
      const cold = await harness({
        historyCheckpointLimit: 0,
        importedStepCacheBytes: 0,
        measuredShapeCacheBytes: 0
      });
      try {
        await qualify(cold, document, [], `${kind} cold idle control`);
      } finally {
        cold.adapter.dispose();
      }
      const subject = await harness();
      try {
        await qualify(subject, document);
        const before = subject.events.length;
        await qualify(subject, document, [], `${kind} first mode transition`);
        expect(subject.events[before]).toMatchObject({
          kind: 'full-rebuild',
          restored: 0,
          replayed: listFeaturesInOrder(document).length
        });
        expect(
          subject.events[before]!.measurementCache?.resetReason ?? null
        ).toBeNull();
        assertLineageOwners(subject.adapter);
      } finally {
        subject.adapter.dispose();
      }
    }
  );

  it.each([
    { name: 'draft', options: { draftAngleDeg: 2 } },
    { name: 'symmetric', options: { symmetric: true } },
    { name: 'two-sided', options: { backDistance: 'tail_height / 2' } }
  ] as const)(
    'preserves strict independent blind $name extrusion across mode changes',
    async ({ name, options }) => {
      let document = await importedTextTailDocument(options);
      for (const demand of [undefined, []] as const) {
        const cold = await harness({
          historyCheckpointLimit: 0,
          importedStepCacheBytes: 0,
          measuredShapeCacheBytes: 0
        });
        try {
          await qualify(cold, document, demand, `${name} cold control`);
        } finally {
          cold.adapter.dispose();
        }
      }
      const subject = await harness();
      try {
        await qualify(subject, document);
        const before = subject.events.length;
        const completed: string[] = [];
        await qualify(subject, document, [], `${name} mode change`, completed);
        expect(subject.events[before]).toMatchObject({
          kind: 'prefix-restore',
          restored: 7,
          replayed: 0
        });
        expect(completed).not.toContain('Text');
        document = setParameter(document, {
          name: 'tail_height',
          expression: '11'
        });
        const beforeEdit = subject.events.length;
        completed.length = 0;
        await qualify(
          subject,
          document,
          [],
          `${name} real tail edit`,
          completed
        );
        expect(subject.events[beforeEdit]).toMatchObject({
          kind: 'prefix-restore',
          restored: 4,
          replayed: 3
        });
        expect(completed).not.toContain('Text');
        expect(completed).toContain('Independent bridge');
        assertLineageOwners(subject.adapter);
      } finally {
        subject.adapter.dispose();
      }
    }
  );

  it('retains the alternate view after actually reusing a fixed transform of an earlier boolean', async () => {
    let document = await preparedBooleanTransformDocument();
    const cold = await harness({
      historyCheckpointLimit: 0,
      importedStepCacheBytes: 0,
      measuredShapeCacheBytes: 0
    });
    try {
      await qualify(cold, document, [], 'Prepared placement cold idle control');
      await qualify(
        cold,
        document,
        undefined,
        'Prepared placement cold eager control'
      );
    } finally {
      cold.adapter.dispose();
    }
    const subject = await harness();
    try {
      await qualify(subject, document);
      document = setParameter(document, {
        name: 'tail_height',
        expression: '11'
      });
      const beforeEdit = subject.events.length;
      const completed: string[] = [];
      await qualify(
        subject,
        document,
        undefined,
        'Prepared fixed placement edit',
        completed
      );
      expect(subject.events[beforeEdit]).toMatchObject({
        kind: 'independent-reuse',
        restored: 4,
        replayed: 3
      });
      expect(
        subject.events[beforeEdit]!.reusedPreparedFeatures
      ).toBeGreaterThan(0);
      expect(completed).not.toContain('Text');
      const beforeIdle = subject.events.length;
      await qualify(
        subject,
        document,
        [],
        'Idle after prepared fixed placement'
      );
      expect(subject.events[beforeIdle]).toMatchObject({
        kind: 'prefix-restore',
        restored: 8,
        replayed: 0
      });
      assertLineageOwners(subject.adapter);
      await qualify(subject, document);
    } finally {
      subject.adapter.dispose();
    }
  });

  it('keeps prepared earlier-boolean placements alive through real edits and replay-budget recycling', async () => {
    // Match the private recipe's fixed-import prefix. An idle recycle cannot
    // create probed eager metadata without violating the no-idle-probe rule;
    // its next eager sync must replay the boolean, while keeping Text restored.
    let document = await preparedBooleanTransformDocument(true);
    expect(
      listFeaturesInOrder(document)
        .slice(0, 4)
        .map((feature) => feature.data.featureKind)
    ).toEqual(['primitive', 'primitive', 'imported-step', 'boolean']);
    const subject = await harness();
    const editEvents: RebuildCacheEvent[] = [];
    const eagerRecoveriesAfterIdleRecycling: number[] = [];
    let textExecutionsOutsideRecycling = 0;
    const unexpectedTextEvents: {
      edit: number;
      kind: string;
      restored: number;
      replayed: number;
      prepared: number;
    }[] = [];
    try {
      await qualify(subject, document);
      const originalKernel = cacheState(subject.adapter).historyKernel;
      for (let edit = 0; edit < 180; edit++) {
        document = setParameter(document, {
          name: 'tail_height',
          expression: String(11 + edit / 10)
        });
        const completed: string[] = [];
        const demand = edit % 2 ? [] : undefined;
        const result = await subject.adapter.syncDocument(
          document,
          (progress) => {
            if (progress.stage === 'feature' && progress.status === 'completed')
              completed.push(progress.name);
          },
          undefined,
          undefined,
          demand === undefined ? undefined : { lineageDemand: demand }
        );
        expect(result.warnings).toEqual([]);
        const event = subject.events.at(-1)!;
        const afterIdleRecycle =
          editEvents.at(-1)?.recycleReason === 'replay-budget' &&
          edit % 2 === 0;
        if (afterIdleRecycle) eagerRecoveriesAfterIdleRecycling.push(edit);
        editEvents.push(event);
        if (event.recycleReason !== 'replay-budget') {
          const textExecutions = completed.filter(
            (name) => name === 'Text'
          ).length;
          textExecutionsOutsideRecycling += textExecutions;
          if (textExecutions > 0)
            unexpectedTextEvents.push({
              edit,
              kind: event.kind,
              restored: event.restored,
              replayed: event.replayed,
              prepared: event.reusedPreparedFeatures ?? 0
            });
        }
        if (
          edit % 45 === 0 ||
          event.recycleReason === 'replay-budget' ||
          afterIdleRecycle
        ) {
          await qualify(
            subject,
            document,
            demand,
            'Sustained prepared placement edit'
          );
          assertLineageOwners(subject.adapter);
        }
      }
      expect(
        editEvents.reduce(
          (sum, event) => sum + (event.reusedPreparedFeatures ?? 0),
          0
        ),
        'The fixed earlier-boolean transform must actually use prepared geometry'
      ).toBeGreaterThan(0);
      expect(
        editEvents.filter((event) => event.recycleReason === 'replay-budget')
          .length,
        'Prepared placements must preserve the unchanged replay recycling budget'
      ).toBeGreaterThan(0);
      expect(
        editEvents.filter(
          (event) => event.kind === 'full-rebuild' && !event.recycleReason
        )
      ).toEqual([]);
      expect(
        textExecutionsOutsideRecycling,
        JSON.stringify({
          unexpectedTextEvents,
          recycleEdits: editEvents.flatMap((event, edit) =>
            event.recycleReason === 'replay-budget' ? [edit] : []
          )
        })
      ).toBe(0);
      expect(eagerRecoveriesAfterIdleRecycling.length).toBeGreaterThan(0);
      for (const [edit, event] of editEvents.entries()) {
        if (event.recycleReason === 'replay-budget')
          expect(event).toMatchObject({
            kind: 'full-rebuild',
            restored: 0,
            replayed: 8
          });
        else if (eagerRecoveriesAfterIdleRecycling.includes(edit)) {
          expect(event).toMatchObject({
            kind: 'prefix-restore',
            restored: 3,
            replayed: 5
          });
          expect(event.reusedPreparedFeatures ?? 0).toBe(0);
        } else {
          expect(event.restored).toBe(4);
          expect(event.replayed).toBe(4 - (event.reusedPreparedFeatures ?? 0));
        }
      }
      expect(cacheState(subject.adapter).historyKernel).not.toBe(
        originalKernel
      );
      await qualify(subject, document, []);
      await qualify(subject, document);
      assertLineageOwners(subject.adapter);
      subject.adapter.dispose();
      expect(cacheState(subject.adapter).historyLineageMetadataBytes).toBe(0);
      await qualify(subject, document, []);
    } finally {
      subject.adapter.dispose();
    }
  });
});
