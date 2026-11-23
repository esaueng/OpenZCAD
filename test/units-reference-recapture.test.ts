/**
 * I03 stored-unit conversion, phase 4 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §3.2, §3.5): the
 * scaled-witness matcher, the profile matcher, and the pure reference map.
 * The kernel round trip is at the end; the corpus-wide refusal rate is in
 * `test/parity/unit-conversion.spec.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  addPrimitiveFeature,
  applyReferenceMap,
  convertDocumentUnits,
  createProjectDocument,
  directEditBody,
  filletEdges,
  listConversionReferenceSites
} from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  type SketchProfile
} from '@openzcad/geometry';
import {
  computeConversionReferenceMap,
  createExactKernelAdapter,
  lineageNameFamily,
  matchScaledProfile,
  matchScaledTopology,
  recaptureWindow,
  scaledWitnessMatches,
  topologyHashOfWitness,
  type SourceTopologyEntity
} from '@openzcad/kernel-adapter/exact';
import {
  toFeatureId,
  toUserId,
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
