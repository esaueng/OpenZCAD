/**
 * I03 stored-unit conversion, phase 4 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §3.2, §3.5): the
 * scaled-witness matcher, the profile matcher, and the pure reference map.
 * The kernel round trip is at the end; the corpus-wide refusal rate is in
 * `test/parity/unit-conversion.spec.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  addDatumAxis,
  addDatumPoint,
  addPrimitiveFeature,
  addSketchFeature,
  applyReferenceMap,
  chamferEdges,
  convertDocumentUnits,
  createProjectDocument,
  directEditBody,
  extrudeSketch,
  filletEdges,
  findSketch,
  importStepBody,
  listConversionReferenceSites
} from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  type SketchProfile
} from '@openzcad/geometry';
import {
  blendOrientationCorrespondence,
  compareBlendOrientations,
  computeConversionReferenceMap,
  createExactKernelAdapter,
  lineageNameFamily,
  matchScaledProfile,
  matchScaledTopology,
  recaptureWindow,
  scaledWitnessMatches,
  topologyHashOfWitness,
  unitConversionGeometryOracle,
  type SourceTopologyEntity
} from '@openzcad/kernel-adapter/exact';
import {
  loadRemusTranslators,
  RemusKernel
} from '../packages/kernel-adapter/src/remus-runtime';
import { recognizePlanarEmboss } from '../packages/kernel-adapter/src/planar-emboss';
import { referenceRecaptureHooks } from '../packages/kernel-adapter/src/reference-recapture-slot';
import type {
  BlendEdgeOrientation,
  BlendOrientationReport
} from '../packages/kernel-adapter/src/blend-orientation';
import { letteredHolder } from './support/lettered-holder';
import {
  toFeatureId,
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopologyReferenceV5,
  type EdgeWitnessV1,
  type FaceWitnessV1,
  type ProjectDocument,
  type QuantizedTopologyPoint,
  type TopologyReferenceV5
} from '@openzcad/shared';

const QUANTUM = 1e-6;
const MM_TO_INCH = 1 / 25.4;
const INCH_TO_MM = 25.4;

const q = (value: number) => Math.round(value / QUANTUM);
const point = (x: number, y: number, z: number): QuantizedTopologyPoint => [
  q(x),
  q(y),
  q(z)
];

/** A planar face witness for a w × h rectangle at height z, in some unit. */
function planeFace(w: number, h: number, z: number, x = 0): FaceWitnessV1 {
  return {
    surfaceType: 'plane',
    perimeter: q(2 * (w + h)),
    centroid: point(x + w / 2, h / 2, z),
    analytic: { kind: 'plane', normal: [0, 0, 1_000_000_000], offset: q(z) },
    closure: { u: 'open', v: 'open' }
  };
}

function lineEdge(
  a: [number, number, number],
  b: [number, number, number]
): EdgeWitnessV1 {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ends = [point(...a), point(...b)].sort(
    (left, right) =>
      left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
  );
  return {
    curveType: 'line',
    length: q(length),
    closed: false,
    endpoints: [ends[0]!, ends[1]!],
    midpoint: point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
  };
}

const scaled = (
  values: [number, number, number],
  k: number
): [number, number, number] => [values[0] * k, values[1] * k, values[2] * k];

describe('the scaled-witness matcher', () => {
  it('matches the one converted face that is the source scaled by k', () => {
    const source: SourceTopologyEntity = {
      kind: 'face',
      witness: planeFace(40, 20, 8),
      lineage: {
        producingFeatureId: toFeatureId('feat_box'),
        lineageName: 'box.face.z-max'
      }
    };
    const candidates = [
      {
        kind: 'face' as const,
        witness: planeFace(40 * MM_TO_INCH, 20 * MM_TO_INCH, 8 * MM_TO_INCH),
        lineage: source.lineage,
        id: 'top'
      },
      {
        kind: 'face' as const,
        witness: planeFace(40 * MM_TO_INCH, 20 * MM_TO_INCH, 0),
        lineage: {
          producingFeatureId: toFeatureId('feat_box'),
          lineageName: 'box.face.z-min'
        },
        id: 'bottom'
      }
    ];
    const match = matchScaledTopology(source, candidates, MM_TO_INCH);
    expect(match).toMatchObject({
      status: 'matched',
      candidate: { id: 'top' }
    });
  });

  it('refuses two faces closer than the target quantum as ambiguous', () => {
    // Converting inch → mm: two coplanar faces 0.4 µm apart in the inch
    // document are 10 nm apart in mm, within one inch quantum (25.4 nm).
    const source: SourceTopologyEntity = {
      kind: 'face',
      witness: planeFace(1, 1, 0.5)
    };
    const near = 0.5 * INCH_TO_MM;
    const candidates = [
      { kind: 'face' as const, witness: planeFace(25.4, 25.4, near) },
      { kind: 'face' as const, witness: planeFace(25.4, 25.4, near + 1e-8) }
    ];
    expect(matchScaledTopology(source, candidates, INCH_TO_MM)).toEqual({
      status: 'ambiguous',
      count: 2
    });
  });

  it('refuses a missing entity', () => {
    const source: SourceTopologyEntity = {
      kind: 'edge',
      witness: lineEdge([0, 0, 0], [10, 0, 0]),
      lineage: {
        producingFeatureId: toFeatureId('feat_box'),
        lineageName: 'box.edge.0'
      }
    };
    // The right geometry under another name, and the right name elsewhere.
    const candidates = [
      {
        kind: 'edge' as const,
        witness: lineEdge([0, 0, 0], scaled([10, 0, 0], MM_TO_INCH)),
        lineage: {
          producingFeatureId: toFeatureId('feat_box'),
          lineageName: 'box.edge.1'
        }
      },
      {
        kind: 'edge' as const,
        witness: lineEdge([0, 0, 0], scaled([0, 10, 0], MM_TO_INCH)),
        lineage: source.lineage
      }
    ];
    expect(matchScaledTopology(source, candidates, MM_TO_INCH)).toEqual({
      status: 'missing',
      count: 0
    });
  });

  it('matches a legacy hash-only pick on its scaled witness alone, uniquely', () => {
    const source: SourceTopologyEntity = {
      kind: 'edge',
      witness: lineEdge([0, 0, 0], [0, 0, 12])
    };
    const corner = (x: number, y: number) => ({
      kind: 'edge' as const,
      witness: lineEdge(scaled([x, y, 0], 0.1), scaled([x, y, 12], 0.1))
    });
    const candidates = [corner(0, 0), corner(30, 0), corner(0, 20)];
    expect(matchScaledTopology(source, candidates, 0.1)).toMatchObject({
      status: 'matched',
      candidate: candidates[0]
    });
    // A named entity is never taken for an unnamed pick.
    const named = [
      {
        ...candidates[0]!,
        lineage: { producingFeatureId: toFeatureId('f'), lineageName: 'n' }
      }
    ];
    expect(matchScaledTopology(source, named, 0.1).status).toBe('missing');
  });

  it('accepts a scaled witness either side of a cell boundary, within two quanta', () => {
    // 12.7000005 mm sits on a 1e-6 mm cell boundary; whichever way the
    // source rounded, the inch value is then measured and rounded again.
    for (const z of [12.7000005, 12.7000005 + 1e-13, 12.7000005 - 1e-13]) {
      const source = planeFace(4, 4, z);
      const target = planeFace(4 * MM_TO_INCH, 4 * MM_TO_INCH, z * MM_TO_INCH);
      expect(scaledWitnessMatches('face', source, target, MM_TO_INCH)).toBe(
        true
      );
    }
    // Arithmetic scaling misses: the rounded scaled integer is not what the
    // converted build measures, so a scaled hash would not resolve.
    const z = 0.0000005 + 1e-9 * 25.4 * 0.5;
    const remeasured = q(z * INCH_TO_MM);
    const arithmetic = Math.round(q(z) * INCH_TO_MM);
    expect(remeasured).not.toBe(arithmetic);
    expect(Math.abs(remeasured - arithmetic)).toBeLessThanOrEqual(
      recaptureWindow(INCH_TO_MM)
    );
  });

  it('refuses a witness three quanta (of the coarser unit) away', () => {
    const source = planeFace(4, 4, 2);
    const off = planeFace(
      4 * MM_TO_INCH,
      4 * MM_TO_INCH,
      2 * MM_TO_INCH + 3 * QUANTUM
    );
    expect(scaledWitnessMatches('face', source, off, MM_TO_INCH)).toBe(false);
    expect(recaptureWindow(MM_TO_INCH)).toBe(2);
    expect(recaptureWindow(INCH_TO_MM)).toBeCloseTo(50.8, 12);
  });

  it('compares open edge endpoints as an unordered pair', () => {
    // Endpoints tie on x and y; scaling a 1e-13 difference can reorder them.
    const source = lineEdge([1, 1, 0], [1, 1, 5]);
    const straight = lineEdge([0.1, 0.1, 0], [0.1, 0.1, 0.5]);
    if (straight.closed) throw new Error('expected an open edge');
    const target: EdgeWitnessV1 = {
      ...straight,
      endpoints: [straight.endpoints[1], straight.endpoints[0]]
    };
    expect(scaledWitnessMatches('edge', source, target, 0.1)).toBe(true);
  });

  it('reduces embedded imported-STEP names to their family', () => {
    expect(
      lineageNameFamily('boolean.face.target.import.step.face.0a1b2c3d')
    ).toBe('boolean.face.target.import.step.face.*');
    expect(lineageNameFamily('box.face.z-max')).toBe('box.face.z-max');
  });
});

function profilesOf(
  circles: { id: string; x: number; y: number; r: number }[]
): SketchProfile[] {
  return computeSketchProfileAnalysis(
    circles.map((circle) => ({
      id: circle.id,
      data: {
        objectKind: 'circle',
        centerX: circle.x,
        centerY: circle.y,
        radius: circle.r
      }
    })),
    (value) => Number(value)
  ).profiles;
}

describe('the scaled-profile matcher (regionFingerprint, profileId)', () => {
  const source = profilesOf([
    { id: 'a', x: 0, y: 0, r: 10 },
    { id: 'b', x: 40, y: 0, r: 5 }
  ]);
  const record = (profile: SketchProfile) => ({
    sourceEntityIds: [...profile.sourceEntityIds].sort().join('|'),
    area: profile.area,
    samplePoint: profile.samplePoint,
    outline: Boolean(profile.outline)
  });

  it('matches the scaled region and re-captures its new fingerprint and id', () => {
    const k = MM_TO_INCH;
    const converted = profilesOf([
      { id: 'a', x: 0, y: 0, r: 10 * k },
      { id: 'b', x: 40 * k, y: 0, r: 5 * k }
    ]);
    const big = source.find((profile) =>
      profile.sourceEntityIds.includes('a')
    )!;
    const match = matchScaledProfile(record(big), converted, k);
    expect(match.status).toBe('matched');
    const chosen = (match as { candidate: SketchProfile }).candidate;
    expect(chosen.sourceEntityIds).toEqual(['a']);
    // The identity hashes change with the unit: re-captured, not scaled.
    expect(chosen.regionFingerprint).not.toBe(big.regionFingerprint);
    expect(chosen.profileId).not.toBe(big.profileId);
  });

  it('refuses a region whose scaled area does not match', () => {
    const converted = profilesOf([
      { id: 'a', x: 0, y: 0, r: 10 * MM_TO_INCH * 1.001 }
    ]);
    const big = source.find((profile) =>
      profile.sourceEntityIds.includes('a')
    )!;
    expect(matchScaledProfile(record(big), converted, MM_TO_INCH).status).toBe(
      'missing'
    );
  });
});

// ---------------------------------------------------------------------------
// The pure map
// ---------------------------------------------------------------------------

function edgeReference(
  witness: EdgeWitnessV1,
  lineageName = 'box.edge.0'
): EdgeTopologyReferenceV5 {
  return {
    kind: 'edge',
    producingFeatureId: toFeatureId('feat_box'),
    lineageName,
    currentHash: topologyHashOfWitness('edge', witness),
    witnessVersion: 1,
    witness
  };
}

function documentWithFillet(
  references: EdgeTopologyReferenceV5[],
  extra: Record<string, unknown> = {}
): ProjectDocument {
  return {
    units: 'mm',
    nodes: {
      feat_fillet: {
        id: 'feat_fillet',
        parentId: null,
        revisionId: null,
        name: 'Fillet 1',
        kind: 'feature',
        featureId: 'feat_fillet',
        featureKind: 'fillet',
        data: {
          featureKind: 'fillet',
          targetBodyId: 'body_box',
          radius: 2,
          edgeHashes: references.map((reference) => reference.currentHash),
          edgeReferences: references,
          ...extra
        }
      }
    }
  } as unknown as ProjectDocument;
}

describe('listConversionReferenceSites and applyReferenceMap', () => {
  const old = edgeReference(lineEdge([0, 0, 0], [10, 0, 0]));
  const next = edgeReference(lineEdge([0, 0, 0], [10 * MM_TO_INCH, 0, 0]));

  it('names every stored identity by JSON pointer', () => {
    const sites = listConversionReferenceSites(documentWithFillet([old]));
    expect(sites.map(({ kind, pointer }) => ({ kind, pointer }))).toEqual([
      { kind: 'hash', pointer: '/nodes/feat_fillet/data/edgeHashes/0' },
      { kind: 'topology', pointer: '/nodes/feat_fillet/data/edgeReferences/0' }
    ]);
  });

  it('applies a complete map without mutating its input', () => {
    const document = documentWithFillet([old]);
    const before = structuredClone(document);
    const result = applyReferenceMap(document, {
      '/nodes/feat_fillet/data/edgeHashes/0': next.currentHash,
      '/nodes/feat_fillet/data/edgeReferences/0': next
    });
    expect(result.ok).toBe(true);
    const data = (result as { document: ProjectDocument }).document.nodes
      .feat_fillet as unknown as {
      data: { edgeHashes: number[]; edgeReferences: TopologyReferenceV5[] };
    };
    expect(data.data.edgeHashes).toEqual([next.currentHash]);
    expect(data.data.edgeReferences).toEqual([next]);
    expect(document).toEqual(before);
  });

  it('refuses a map that misses a site, names an unknown one, or mistypes one', () => {
    const document = documentWithFillet([old]);
    // A reference object where a hash belongs.
    const wrongType: number | TopologyReferenceV5 = next;
    const result = applyReferenceMap(document, {
      '/nodes/feat_fillet/data/edgeHashes/0': wrongType,
      '/nodes/feat_fillet/data/radius': 3
    });
    expect(result.ok).toBe(false);
    expect(
      (
        result as { refusals: { code: string; pointer: string }[] }
      ).refusals.map(({ code, pointer }) => `${code} ${pointer}`)
    ).toEqual([
      'unknown-site /nodes/feat_fillet/data/radius',
      'wrong-type /nodes/feat_fillet/data/edgeHashes/0',
      'missing-site /nodes/feat_fillet/data/edgeReferences/0'
    ]);
  });

  it('refuses an edge reference whose witness does not hash to its currentHash', () => {
    const document = documentWithFillet([old]);
    const result = applyReferenceMap(document, {
      '/nodes/feat_fillet/data/edgeHashes/0': next.currentHash,
      '/nodes/feat_fillet/data/edgeReferences/0': {
        ...next,
        currentHash: next.currentHash + 1
      }
    });
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ code: 'invalid-reference' }]
    });
  });
});

// ---------------------------------------------------------------------------
// Through the kernel
// ---------------------------------------------------------------------------

/**
 * A box whose twelve edges are filleted by v5 reference, then its top face
 * offset by v5 reference: the corpus holds few v5 picks, this holds 13 of
 * each kind of site. Its height sits on a 1e-6 mm cell boundary.
 */
async function filletedBox(): Promise<ProjectDocument> {
  const adapter = await createExactKernelAdapter();
  try {
    const base = addPrimitiveFeature(
      createProjectDocument('Re-capture box', toUserId('user_recapture')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 12.7000005, depth: 10 }
      }
    );
    const bodyId = base.bodyOrder[0]!;
    const first = await adapter.syncDocument(base);
    const edges = (
      first.bodyRepresentations[bodyId]?.topology?.edges ?? []
    ).filter((edge) => edge.displayRole !== 'seam' && edge.reference);
    expect(edges).toHaveLength(12);
    const filleted = filletEdges(base, {
      name: 'Blend all edges',
      targetBodyId: bodyId,
      edgeHashes: edges.map((edge) => edge.hash),
      edgeReferences: edges.map((edge) => edge.reference!),
      size: 1.5
    });
    const second = await adapter.syncDocument(filleted.document);
    expect(second.warnings).toEqual([]);
    const top = (
      second.bodyRepresentations[filleted.bodyId]?.topology?.faces ?? []
    ).find(
      (face) =>
        face.reference?.lineageName === 'modifier.box.face.z-max' &&
        face.geometry?.normal !== undefined
    )!;
    expect(top).toBeDefined();
    const edited = directEditBody(filleted.document, {
      name: 'Raise top',
      targetBodyId: filleted.bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: top.hash,
        faceReference: top.reference!,
        sourceSurfaceType: 'plane',
        sourceArea: top.geometry!.area,
        sourceCenter: top.geometry!.center,
        sourceNormal: top.geometry!.normal!,
        offset: 5
      }
    }).document;
    expect((await adapter.syncDocument(edited)).warnings).toEqual([]);
    return edited;
  } finally {
    adapter.dispose();
  }
}

describe('computeConversionReferenceMap', { timeout: 120_000 }, () => {
  it('refuses metre documents before building', async () => {
    const document = { units: 'm' } as ProjectDocument;
    const result = await computeConversionReferenceMap(document, {
      units: 'mm'
    } as ProjectDocument);
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ code: 'unsupported-unit' }]
    });
  });

  it('re-captures v5 edge and face references, verified by rebuild, and round-trips', async () => {
    const source = await filletedBox();
    const sites = listConversionReferenceSites(source);
    expect(sites.filter((site) => site.kind === 'topology')).toHaveLength(13);
    expect(sites.filter((site) => site.kind === 'hash')).toHaveLength(13);

    const there = convertDocumentUnits(source, 'inch');
    expect(there.ok).toBe(true);
    if (!there.ok) return;
    const result = await computeConversionReferenceMap(source, there.document);
    expect(result.ok ? [] : result.refusals).toEqual([]);
    if (!result.ok) return;
    expect(Object.keys(result.references)).toHaveLength(26);
    for (const site of listConversionReferenceSites(result.document)) {
      // Every identity changed, and each v5 reference's hash is its own
      // re-measured witness's hash, with the same name.
      const before = sites.find((other) => other.pointer === site.pointer)!;
      if (site.kind === 'topology' && before.kind === 'topology') {
        expect(site.reference.currentHash).not.toBe(
          before.reference.currentHash
        );
        expect(site.reference.lineageName).toBe(before.reference.lineageName);
        expect(site.reference.currentHash).toBe(
          site.reference.kind === 'edge'
            ? topologyHashOfWitness('edge', site.reference.witness)
            : topologyHashOfWitness('face', site.reference.witness)
        );
      }
    }
    expect(result.report.geometry.bodies).toBeGreaterThan(0);

    const back = convertDocumentUnits(result.document, 'mm');
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const returned = await computeConversionReferenceMap(
      result.document,
      back.document
    );
    expect(returned.ok ? [] : returned.refusals).toEqual([]);
    if (!returned.ok) return;
    // Witness hashes match the original after the round trip (plan §6).
    expect(listConversionReferenceSites(returned.document)).toEqual(sites);
  });

  it('refuses a stored reference the source build never resolves, naming it', async () => {
    const source = await filletedBox();
    const there = convertDocumentUnits(source, 'cm');
    if (!there.ok) throw new Error('conversion refused');
    // Suppress the offset edit: its face reference is then never looked up.
    const suppress = (document: ProjectDocument) => {
      const next = structuredClone(document);
      for (const node of Object.values(next.nodes))
        if (node.kind === 'feature' && node.name === 'Raise top')
          node.metadata = { ...node.metadata, suppressed: true };
      return next;
    };
    const result = await computeConversionReferenceMap(
      suppress(source),
      suppress(there.document)
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.refusals.map(({ code, subject, field }) => ({
        code,
        subject: subject.replace(/ \(.*\)$/, ''),
        field
      }))
    ).toEqual([
      {
        code: 'source-unresolved',
        subject: 'Raise top',
        field: 'operation.faceHash'
      },
      {
        code: 'source-unresolved',
        subject: 'Raise top',
        field: 'operation.faceReference'
      }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Review regressions (PR #1977)
// ---------------------------------------------------------------------------

async function buildOnce(document: ProjectDocument): Promise<DerivedState> {
  const adapter = await createExactKernelAdapter();
  try {
    return await adapter.syncDocument(document);
  } finally {
    adapter.dispose();
  }
}

/**
 * A pad whose left side runs from (0, 10, 0) to (0.000002, 0, 0) mm. In mm
 * the first point is witness end 0 (x 0 < 2 quanta); in inches both x
 * coordinates quantize to 0, so end 0 becomes the second point (y sorts).
 */
async function nearTiePad(): Promise<{
  document: ProjectDocument;
  bodyId: BodyId;
  edge: EdgeTopologyReferenceV5;
}> {
  const lines = [
    [0, 10, 0.000002, 0],
    [0.000002, 0, 20, 0],
    [20, 0, 20, 10],
    [20, 10, 0, 10]
  ] as const;
  const sketched = addSketchFeature(
    createProjectDocument('Near tie', toUserId('user_recapture')),
    {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: lines.map(([x1, y1, x2, y2]) => ({
        objectKind: 'line' as const,
        x1,
        y1,
        x2,
        y2
      }))
    }
  );
  const objectIds = [
    ...(findSketch(sketched.document, sketched.sketchId)?.objectIds ?? [])
  ];
  const { document, bodyId } = extrudeSketch(sketched.document, {
    name: 'Pad',
    sketchId: sketched.sketchId,
    distance: 5,
    profiles: [{ all: true, sourceEntityIds: objectIds }]
  });
  const derived = await buildOnce(document);
  expect(derived.warnings).toEqual([]);
  const edge = derived.bodyRepresentations[bodyId]?.topology?.edges.find(
    (candidate) => {
      const witness = candidate.reference?.witness;
      return (
        witness !== undefined &&
        !witness.closed &&
        JSON.stringify(witness.endpoints) ===
          JSON.stringify([
            [0, 10_000_000, 0],
            [2, 0, 0]
          ])
      );
    }
  )?.reference;
  if (!edge) throw new Error('The near-tie edge was not built.');
  return { document, bodyId, edge };
}

describe('re-capture review regressions', { timeout: 180_000 }, () => {
  it('remaps a datum vertex end when the converted witness orders the ends the other way', async () => {
    const { document: pad, bodyId, edge } = await nearTiePad();
    const { document: source, featureId } = addDatumPoint(pad, {
      name: 'Corner',
      definition: {
        kind: 'offset',
        from: { type: 'edge-vertex', bodyId, edgeReference: edge, end: 0 },
        offset: { x: 0, y: 0, z: 0 }
      }
    });
    const before = await buildOnce(source);
    expect(before.datumPoints?.[featureId]).toEqual({ x: 0, y: 10, z: 0 });

    const there = convertDocumentUnits(source, 'inch');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document);
    expect(result.ok ? [] : result.refusals).toEqual([]);
    if (!result.ok) return;
    const node = Object.values(result.document.nodes).find(
      (candidate) =>
        candidate.kind === 'feature' && candidate.featureId === featureId
    ) as unknown as {
      data: { definition: { from: { end: 0 | 1 } } };
    };
    expect(node.data.definition.from.end).toBe(1);
    const after = await buildOnce(result.document);
    const point = after.datumPoints?.[featureId];
    expect(point?.x).toBeCloseTo(0, 9);
    expect(point?.y).toBeCloseTo(10 / 25.4, 9);
    expect(point?.z).toBeCloseTo(0, 9);
    expect(result.report.geometry.datums).toBe(1);
  });

  it('refuses an edge whose end order is significant when the ends swap', async () => {
    const { document: pad, bodyId, edge } = await nearTiePad();
    const source = addDatumAxis(pad, {
      name: 'Side axis',
      definition: {
        kind: 'edge',
        source: { type: 'edge', bodyId, edgeReference: edge }
      }
    }).document;
    const there = convertDocumentUnits(source, 'inch');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.refusals.map(({ code, subject, field }) => ({
        code,
        subject: subject.replace(/ \(.*\)$/, ''),
        field
      }))
    ).toEqual([
      {
        code: 'endpoint-order',
        subject: 'Side axis',
        field: 'definition.source.edgeReference'
      }
    ]);
  });

  it('the geometry oracle refuses a datum that moved, even when every body matches', () => {
    const empty = (point: { x: number; y: number; z: number }) =>
      ({
        bodyRepresentations: {},
        exportableBodyIds: [],
        warnings: [],
        datumPoints: { feat_point: point }
      }) as unknown as DerivedState;
    const k = MM_TO_INCH;
    const same = unitConversionGeometryOracle(
      empty({ x: 0, y: 10, z: 0 }),
      empty({ x: 0, y: 10 * k, z: 0 }),
      k
    );
    const moved = unitConversionGeometryOracle(
      empty({ x: 0, y: 10, z: 0 }),
      empty({ x: 0.000002 * k, y: 0, z: 0 }),
      k
    );
    expect(moved.refusals.map(({ code, field }) => `${code} ${field}`)).toEqual(
      ['geometry-mismatch datumPoints.y']
    );
    expect(same.refusals).toEqual([]);
    expect(same.stats.datums).toBe(1);
  });

  /**
   * Two inch boxes whose +Y faces sit at 1.0000001 and 1.0000004 in: one
   * legacy fingerprint in inches, two in millimetres. Each is offset by a
   * hash-only pick.
   */
  async function twinBoxes(): Promise<ProjectDocument> {
    let document = createProjectDocument(
      'Twins',
      toUserId('user_recapture'),
      'inch'
    );
    for (const [name, height] of [
      ['A', 1.0000001],
      ['B', 1.0000004]
    ] as const)
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 2, height, depth: 1 }
      });
    const built = await buildOnce(document);
    const tops = document.bodyOrder.map((bodyId) =>
      built.bodyRepresentations[bodyId]!.topology!.faces.find(
        (face) => face.geometry?.normal?.y === 1
      )!
    );
    // The shared legacy fingerprint the review describes.
    expect(tops[0]!.hash).toBe(tops[1]!.hash);
    document.bodyOrder.forEach((bodyId, index) => {
      const top = tops[index]!;
      document = directEditBody(document, {
        name: `Raise ${index === 0 ? 'A' : 'B'}`,
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: top.hash,
          sourceSurfaceType: 'plane',
          sourceArea: top.geometry!.area,
          sourceCenter: top.geometry!.center,
          sourceNormal: top.geometry!.normal!,
          offset: 0.5
        }
      }).document;
    });
    expect((await buildOnce(document)).warnings).toEqual([]);
    return document;
  }

  const suppressing = (name: string, document: ProjectDocument) => {
    const next = structuredClone(document);
    for (const node of Object.values(next.nodes))
      if (node.kind === 'feature' && node.name === name)
        node.metadata = { ...node.metadata, suppressed: true };
    return next;
  };

  it('never lets one feature’s lookup stand in for a suppressed feature’s identical hash', async () => {
    const source = suppressing('Raise B', await twinBoxes());
    const there = convertDocumentUnits(source, 'mm');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.refusals.map(({ code, subject, field }) => ({
        code,
        subject: subject.replace(/ \(.*\)$/, ''),
        field
      }))
    ).toEqual([
      {
        code: 'source-unresolved',
        subject: 'Raise B',
        field: 'operation.faceHash'
      }
    ]);
  });

  it('re-captures two features’ identical hashes each from its own lookup', async () => {
    const source = await twinBoxes();
    const there = convertDocumentUnits(source, 'mm');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document);
    expect(result.ok ? [] : result.refusals).toEqual([]);
    if (!result.ok) return;
    const hashes = listConversionReferenceSites(result.document).map(
      (site) => site.kind === 'hash' && site.hash
    );
    expect(hashes).toHaveLength(2);
    expect(new Set(hashes).size).toBe(2);
    expect((await buildOnce(result.document)).warnings).toEqual([]);
  });

  it('refuses imported raised lettering by name (a known limitation)', async () => {
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    let source: ProjectDocument;
    try {
      const step = io.exportStep(
        kernel.serializeSolids(Uint32Array.of(letteredHolder(kernel)))
      );
      const solids = kernel.deserializeSolids(io.importStep(step));
      const selection = recognizePlanarEmboss(kernel, solids[0]!);
      if (!selection) throw new Error('The lettering must be recognized.');
      source = importStepBody(
        createProjectDocument('Lettering', toUserId('user_recapture')),
        {
          name: 'Text',
          artifactId: 'public-generated-lettering',
          sourceName: 'public-generated-lettering.step',
          stepText: new TextDecoder().decode(step),
          planarEmboss: { part: 'text', selection }
        }
      ).document;
    } finally {
      kernel.free();
    }
    expect((await buildOnce(source)).warnings).toEqual([]);
    const there = convertDocumentUnits(source, 'inch');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The lettering check compares its whole measured selection (hashes,
    // tidied depth and bounds) as one serialized key, never through a
    // re-capture hook, so its hashes are never looked up. Fails closed.
    expect(
      [
        ...new Set(
          result.refusals.map(
            ({ code, field }) => `${code} ${field?.replace(/\.\d+$/, '')}`
          )
        )
      ].sort()
    ).toEqual([
      'source-unresolved planarEmboss.selection.capFaceHashes',
      'source-unresolved planarEmboss.selection.supportFaceHash'
    ]);
  });

  it('returns busy, not a rejected promise, to a second call in the same tick', async () => {
    const source = await filletedBox();
    const there = convertDocumentUnits(source, 'cm');
    if (!there.ok) throw new Error('conversion refused');
    const [first, second] = await Promise.all([
      computeConversionReferenceMap(source, there.document),
      computeConversionReferenceMap(source, there.document)
    ]);
    expect(first.ok ? [] : first.refusals).toEqual([]);
    expect(second).toMatchObject({
      ok: false,
      refusals: [{ code: 'busy' }]
    });
  });
});

/**
 * Review of PR 1977: an asymmetric blend reads the kernel's native edge
 * direction or face order, which a witness match cannot see.
 */
describe('native blend orientation', { timeout: 180_000 }, () => {
  const k = MM_TO_INCH;
  const pt = (x: number, y: number, z: number) => [x, y, z] as const;
  const edge = (
    samples: (readonly [number, number, number])[],
    faces: FaceWitnessV1[]
  ): BlendEdgeOrientation => ({
    samples: samples as unknown as BlendEdgeOrientation['samples'],
    faces
  });
  const sourceEdge = edge(
    [pt(0, 0, 0), pt(10, 0, 0), pt(30, 0, 0), pt(40, 0, 0)],
    [planeFace(40, 10, 0), planeFace(40, 12, 10)]
  );
  const scaledEdge = (order: 'same' | 'reversed' | 'faces') => {
    const samples = sourceEdge.samples.map((sample) =>
      scaled([...sample], k)
    );
    const faces = [planeFace(40 * k, 10 * k, 0), planeFace(40 * k, 12 * k, 10 * k)];
    return edge(
      order === 'reversed' ? samples.reverse() : samples,
      order === 'faces' ? faces.reverse() : faces
    );
  };

  it('tells a kept, reversed and face-swapped edge apart', () => {
    expect(
      blendOrientationCorrespondence(sourceEdge, scaledEdge('same'), k)
    ).toBe('same');
    expect(
      blendOrientationCorrespondence(sourceEdge, scaledEdge('reversed'), k)
    ).toBe('reversed');
    expect(
      blendOrientationCorrespondence(sourceEdge, scaledEdge('faces'), k)
    ).toBe('reversed');
    // A closed edge's start and end coincide; its curve samples still decide.
    const loop = edge(
      [pt(1, 0, 0), pt(0, 1, 0), pt(0, -1, 0), pt(1, 0, 0)],
      [planeFace(2, 2, 0)]
    );
    const flipped = edge(
      [pt(k, 0, 0), pt(0, -k, 0), pt(0, k, 0), pt(k, 0, 0)],
      [planeFace(2 * k, 2 * k, 0)]
    );
    expect(blendOrientationCorrespondence(loop, flipped, k)).toBe('reversed');
  });

  it('refuses a blend whose edge set changed, by feature', () => {
    const refusals = compareBlendOrientations(
      new Map([
        ['feat_a', [{ label: 'selection', reads: 'r', edges: [sourceEdge] }]]
      ]),
      new Map(),
      k,
      (feature) => `Fillet (${feature})`,
      'converted'
    );
    expect(refusals.map(({ code, subject }) => `${code} ${subject}`)).toEqual([
      'blend-orientation Fillet (feat_a)'
    ]);
  });

  /** One box edge blended by `blend`, in millimetres. */
  async function blendedBox(
    blend: (
      document: ProjectDocument,
      input: {
        name: string;
        targetBodyId: BodyId;
        edgeHashes: number[];
        edgeReferences: EdgeTopologyReferenceV5[];
      }
    ) => ProjectDocument
  ): Promise<ProjectDocument> {
    const base = addPrimitiveFeature(
      createProjectDocument('Blend orientation', toUserId('user_recapture')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 12, depth: 10 }
      }
    );
    const bodyId = base.bodyOrder[0]!;
    const built = await buildOnce(base);
    const picked = (built.bodyRepresentations[bodyId]?.topology?.edges ?? [])
      .filter((candidate) => candidate.displayRole !== 'seam')
      .find((candidate) => candidate.reference)!;
    const document = blend(base, {
      name: 'Blend',
      targetBodyId: bodyId,
      edgeHashes: [picked.hash],
      edgeReferences: [picked.reference!]
    });
    expect((await buildOnce(document)).warnings).toEqual([]);
    return document;
  }

  const variableFillet = () =>
    blendedBox(
      (document, input) =>
        filletEdges(document, { ...input, size: 1, endRadius: 3 }).document
    );
  const twoDistanceChamfer = () =>
    blendedBox(
      (document, input) =>
        chamferEdges(document, { ...input, size: 1, distance2: 2.5 }).document
    );

  /**
   * Cold adapters for the three re-capture builds; build `which` (2: the
   * converted build, 3: the verification build) reports every blend edge
   * through `mutate`, as a kernel that rebuilt it the other way would.
   */
  function reorienting(
    which: number,
    mutate: (edge: BlendEdgeOrientation) => BlendEdgeOrientation
  ) {
    let builds = 0;
    return async () => {
      const real = await createExactKernelAdapter({
        historyCheckpointLimit: 0,
        importedStepCacheBytes: 0,
        importedMeshCacheBytes: 0,
        measuredShapeCacheBytes: 0
      });
      builds += 1;
      if (builds !== which) return real;
      const syncDocument = real.syncDocument.bind(real);
      real.syncDocument = async (document) => {
        const hooks = referenceRecaptureHooks();
        const note = hooks?.noteBlendOrientation;
        if (hooks && note)
          hooks.noteBlendOrientation = (report: BlendOrientationReport) =>
            note.call(hooks, { ...report, edges: report.edges.map(mutate) });
        return syncDocument(document);
      };
      return real;
    };
  }
  const reverse = (edge: BlendEdgeOrientation): BlendEdgeOrientation => ({
    ...edge,
    samples: [...edge.samples].reverse() as never
  });
  const swapFaces = (edge: BlendEdgeOrientation): BlendEdgeOrientation => ({
    ...edge,
    faces: [...edge.faces].reverse()
  });
  const codes = (
    result: Awaited<ReturnType<typeof computeConversionReferenceMap>>
  ) =>
    result.ok
      ? []
      : result.refusals.map(
          ({ code, subject, field }) =>
            `${code} ${subject.replace(/ \(.*\)$/, '')} ${field}`
        );

  it('re-captures a two-distance chamfer whose edges keep their direction', async () => {
    const source = await twoDistanceChamfer();
    const there = convertDocumentUnits(source, 'inch');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document);
    expect(codes(result)).toEqual([]);
    expect(result.ok && result.report.geometry.faces).toBeGreaterThan(0);
  });

  it('passes a variable fillet’s orientation, which the area oracle then refuses', async () => {
    // Remus fits the variable blend face to a B-spline within a tolerance
    // that does not scale with the unit, so its area differs between the
    // two builds well past 1e-6 and the existing oracle refuses it. The
    // orientation check itself accepts the unreversed edge.
    const source = await variableFillet();
    const there = convertDocumentUnits(source, 'inch');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document);
    expect(codes(result)).toEqual(['geometry-mismatch Block Body area']);
  });

  it('refuses a variable fillet whose edge the converted build runs the other way', async () => {
    const source = await variableFillet();
    const there = convertDocumentUnits(source, 'inch');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document, {
      createAdapter: reorienting(2, reverse)
    });
    expect(codes(result)).toEqual(['blend-orientation Blend edgeHashes.0']);
  });

  it('refuses a two-distance chamfer whose faces the verification build lists the other way', async () => {
    const source = await twoDistanceChamfer();
    const there = convertDocumentUnits(source, 'cm');
    if (!there.ok) throw new Error('conversion refused');
    const result = await computeConversionReferenceMap(source, there.document, {
      createAdapter: reorienting(3, swapFaces)
    });
    expect(codes(result)).toEqual(['blend-orientation Blend edgeHashes.0']);
  });

  it('the geometry oracle refuses a blend built mirrored on a symmetric body', () => {
    // Two trimmed faces whose vertex means, areas and totals all survive the
    // swap; only their area centroids trade places.
    const body = (
      unit: number,
      [left, right]: [number, number]
    ): DerivedState =>
      ({
        bodyRepresentations: {
          body_1: {
            name: 'Block',
            bbox: {
              min: { x: -20 * unit, y: 0, z: 0 },
              max: { x: 20 * unit, y: 10 * unit, z: 10 * unit }
            },
            volume: 4000 * unit ** 3,
            faceCount: 2,
            consumed: false,
            exportableStep: true,
            topology: {
              faces: [10, 12].map((area, index) => ({
                topologyId: `f${index}`,
                hash: index + 1,
                triangleStart: 0,
                triangleCount: 0,
                geometry: {
                  surfaceType: 'plane',
                  area: area * unit ** 2,
                  center: { x: 0, y: 5 * unit, z: index * 10 * unit },
                  centroid: {
                    x: (index === 0 ? left : right) * unit,
                    y: 5 * unit,
                    z: index * 10 * unit
                  },
                  centroidProvenance: 'exact'
                }
              })),
              edges: [],
              vertices: []
            }
          }
        },
        exportableBodyIds: ['body_1'],
        warnings: []
      }) as unknown as DerivedState;
    const kept = unitConversionGeometryOracle(
      body(1, [-1, 1]),
      body(k, [-1, 1]),
      k
    );
    expect(kept.refusals).toEqual([]);
    expect(kept.stats.faces).toBe(2);
    const mirrored = unitConversionGeometryOracle(
      body(1, [-1, 1]),
      body(k, [1, -1]),
      k
    );
    expect(
      mirrored.refusals.map(({ code, field }) => `${code} ${field}`)
    ).toEqual(['geometry-mismatch faces.0', 'geometry-mismatch faces.1']);
  });
});

describe('datum position tolerance', () => {
  const at = (x: number, y: number) =>
    ({
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      datumPoints: { feat_point: { x, y, z: 0 } }
    }) as unknown as DerivedState;

  it('is per component: a far-out X never widens the check on Y', () => {
    for (const x of [0, 1000]) {
      const moved = unitConversionGeometryOracle(
        at(x, 0),
        at(x, 0.0000015),
        1
      );
      expect(
        moved.refusals.map(({ code, field }) => `${code} ${field}`)
      ).toEqual(['geometry-mismatch datumPoints.y']);
      // Kernel noise on the far-out component itself is still accepted.
      expect(
        unitConversionGeometryOracle(at(x, 0), at(x * (1 + 1e-13), 0), 1)
          .refusals
      ).toEqual([]);
    }
  });
});
