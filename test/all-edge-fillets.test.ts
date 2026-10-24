import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAllEdgesFilletProposal,
  createCadDocumentDigest,
  parseAllEdgesFilletRequest,
  parseCadPatchProposal,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

const selection: CadSelectionContext = {
  bodyIds: [],
  featureIds: [],
  topologies: []
};

/** Capture the exact body the adapter sends to the STEP translator. */
async function exportStepArena(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  bodyId: BodyId
) {
  const serialize = vi.spyOn(RemusKernel.prototype, 'serializeSolids');
  try {
    const step = await adapter.exportStep(document, [bodyId]);
    expect(serialize).toHaveBeenCalledTimes(1);
    const result = serialize.mock.results[0];
    if (result?.type !== 'return')
      throw new Error('STEP export did not serialize a body.');
    return { step, arena: new Uint8Array(result.value) };
  } finally {
    serialize.mockRestore();
  }
}

/** Compare physical geometry without depending on arena or traversal order. */
function expectRoundedBoxGeometryPreserved(
  before: Uint8Array,
  after: Uint8Array
) {
  const kernel = new RemusKernel();
  const compareNumbers = (
    left: readonly number[],
    right: readonly number[]
  ) => {
    expect(right).toHaveLength(left.length);
    for (const [index, value] of left.entries()) {
      expect(Math.abs(right[index]! - value)).toBeLessThan(1e-12);
    }
  };
  const compareRows = (
    left: readonly number[][],
    right: readonly number[][]
  ) => {
    const remaining = [...right];
    expect(right).toHaveLength(left.length);
    for (const expected of left) {
      const matches = remaining.flatMap((actual, index) =>
        actual.length === expected.length &&
        actual.every(
          (value, coordinate) => Math.abs(value - expected[coordinate]!) < 1e-12
        )
          ? [index]
          : []
      );
      expect(matches).toHaveLength(1);
      const [actual] = remaining.splice(matches[0]!, 1);
      compareNumbers(expected, actual!);
    }
    expect(remaining).toEqual([]);
  };
  const edgeGeometry = (edge: number) => {
    const [lo, hi] = kernel.getEdgeParamSpan(edge);
    const ends = Array.from(kernel.getEdgeVertexHandles(edge), (vertex) =>
      Array.from(kernel.getVertexPosition(vertex))
    );
    const firstDifference = ends[0]!.findIndex(
      (coordinate, axis) => Math.abs(coordinate - ends[1]![axis]!) > 1e-12
    );
    const reverse =
      firstDifference >= 0 &&
      ends[0]![firstDifference]! > ends[1]![firstDifference]!;
    const orderedEnds = reverse ? [...ends].reverse() : ends;
    const lowPoint = Array.from(kernel.evaluateEdgeCurve(edge, lo!));
    const highPoint = Array.from(kernel.evaluateEdgeCurve(edge, hi!));
    const samePoint = (left: readonly number[], right: readonly number[]) =>
      left.length === right.length &&
      left.every(
        (coordinate, axis) => Math.abs(coordinate - right[axis]!) < 1e-12
      );
    const forward =
      samePoint(lowPoint, orderedEnds[0]!) &&
      samePoint(highPoint, orderedEnds[1]!);
    const backward =
      samePoint(highPoint, orderedEnds[0]!) &&
      samePoint(lowPoint, orderedEnds[1]!);
    expect(Number(forward) + Number(backward)).toBe(1);
    const fractions = forward
      ? [0, 0.25, 0.5, 0.75, 1]
      : [1, 0.75, 0.5, 0.25, 0];
    return [
      kernel.getEdgeCurveType(edge) === 'LINE' ? 0 : 1,
      Math.abs(hi! - lo!),
      kernel.edgeLength(edge),
      ...orderedEnds.flat(),
      ...fractions.flatMap((fraction) =>
        Array.from(kernel.evaluateEdgeCurve(edge, lo! + (hi! - lo!) * fraction))
      )
    ];
  };
  const snapshot = (bytes: Uint8Array) => {
    const solids = kernel.deserializeSolids(bytes);
    expect(solids).toHaveLength(1);
    const solid = solids[0]!;
    expect(kernel.validateSolid(solid)).toBe(0);
    const validation: unknown = JSON.parse(
      kernel.validateSolidDetailed(solid) as string
    );
    expect(validation).toEqual({ errorCount: 0, warningCount: 0, issues: [] });
    const topology = JSON.parse(kernel.toBrepJson(solid) as string) as {
      faces: { id: number; reversed: boolean }[];
    };
    const orientations = new Map(
      topology.faces.map((face) => [face.id, face.reversed])
    );
    const faces = Array.from(kernel.getSolidFaces(solid));
    const edges = Array.from(kernel.getSolidEdges(solid));
    const vertices = Array.from(kernel.getSolidVertices(solid));
    expect([faces.length, edges.length, vertices.length]).toEqual([26, 48, 24]);
    expect(faces.map((face) => kernel.getSurfaceType(face)).sort()).toEqual([
      ...Array<string>(12).fill('cylinder'),
      ...Array<string>(6).fill('plane'),
      ...Array<string>(8).fill('sphere')
    ]);
    expect(edges.map((edge) => kernel.getEdgeCurveType(edge)).sort()).toEqual([
      ...Array<string>(24).fill('CIRCLE'),
      ...Array<string>(24).fill('LINE')
    ]);
    return {
      bounds: Array.from(kernel.boundingBox(solid)),
      vertices: vertices.map((vertex) =>
        Array.from(kernel.getVertexPosition(vertex))
      ),
      faces: faces.map((face) => {
        expect(kernel.getFaceWires(face)).toHaveLength(1);
        const parameters: unknown = JSON.parse(
          kernel.getAnalyticSurfaceParams(face)
        );
        const reversed = orientations.get(face);
        expect(typeof reversed).toBe('boolean');
        return {
          carrier: JSON.stringify(parameters),
          reversed,
          edges: Array.from(kernel.getFaceEdges(face), edgeGeometry)
        };
      })
    };
  };
  try {
    const source = snapshot(before);
    const imported = snapshot(after);
    compareNumbers(source.bounds, imported.bounds);
    compareRows(source.vertices, imported.vertices);
    const remaining = [...imported.faces];
    for (const face of source.faces) {
      const matches = remaining.flatMap((candidate, index) =>
        candidate.carrier === face.carrier ? [index] : []
      );
      expect(matches).toHaveLength(1);
      const [matched] = remaining.splice(matches[0]!, 1);
      expect(matched!.reversed).toBe(face.reversed);
      compareRows(face.edges, matched!.edges);
    }
    expect(remaining).toEqual([]);
  } finally {
    kernel.free();
  }
}

describe('whole-part fillet requests', () => {
  it.each([
    'Fillet all edges',
    'add a filet on all the edges',
    'Please add a fillet to all edges',
    'Could you round every edge?',
    '\u2003Could you please round every edge.!?\u2003',
    'Fillet each edge',
    'round over all edges'
  ])('recognizes %s without a provider', (prompt) => {
    expect(parseAllEdgesFilletRequest(prompt)).toMatchObject({
      radius: null,
      target: null
    });
  });

  it.each([
    ['Add a 1.5mm fillet to all edges', 1.5, 'mm'],
    ['Fillet all edges with a 0.5 mm radius', 0.5, 'mm'],
    ['Round every edge by 0.1 inch', 0.1, 'inch'],
    ['Fillet all edges at radius 2', 2, undefined]
  ])('reads the radius in %s', (prompt, radius, unit) => {
    expect(parseAllEdgesFilletRequest(prompt)).toMatchObject({
      radius,
      unit
    });
  });

  it.each([
    "Don't fillet all edges",
    'Explain how to fillet all edges',
    'Fillet all outside edges',
    'Fillet all edges except the hole rims',
    'Fillet the selected edges',
    'Fillet all edges and drill a hole',
    'Add a 2 mm fillet to all edges by 1 mm',
    'Fillet all edges! ?',
    'Fillet all edges!?x'
  ])('leaves other instructions to the provider: %s', (prompt) => {
    expect(parseAllEdgesFilletRequest(prompt)).toBeNull();
  });
});

describe('whole-part exact fillet proposals', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  let box: ProjectDocument;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    box = addPrimitiveFeature(
      createProjectDocument('Block', toUserId('user_fillet')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 20 }
      }
    );
    box = { ...box, derived: await adapter.syncDocument(box) };
  });
  afterAll(() => adapter.dispose());

  it('rounds all twelve edges and eight corners, exports, and reimports', async () => {
    const result = createAllEdgesFilletProposal(
      box,
      selection,
      'Add a fillet on all edges'
    );
    expect(result?.error).toBeUndefined();
    const proposal = parseCadPatchProposal(result!.proposal);
    expect(proposal.operations[0]).toMatchObject({
      size: 2
    });
    expect(
      proposal.operations[0]!.kind === 'add_edge_modifier' &&
        proposal.operations[0].edgeHashes
    ).toHaveLength(12);
    const preview = await preflightCadPatch(box, proposal, (candidate) =>
      adapter.syncDocument(candidate)
    );
    expect(preview.candidate.derived.warnings).toEqual([]);
    const bodyId = preview.candidate.derived.exportableBodyIds[0]!;
    const rounded = preview.candidate.derived.bodyRepresentations[bodyId]!;
    expect(rounded.volume).toBeLessThan(40 * 30 * 20);
    const surfaces = rounded.topology!.faces.map(
      (face) => face.geometry?.surfaceType
    );
    expect(surfaces.filter((type) => type === 'cylinder')).toHaveLength(12);
    expect(surfaces.filter((type) => type === 'sphere')).toHaveLength(8);
    const { step, arena: originalArena } = await exportStepArena(
      adapter,
      preview.candidate,
      bodyId
    );
    const imported = importStepBody(
      createProjectDocument('Round trip', toUserId('user_fillet')),
      {
        name: 'Rounded block',
        artifactId: 'round-trip',
        sourceName: 'rounded.step',
        stepText: step
      }
    );
    const rebuilt = await adapter.syncDocument(imported.document);
    expect(rebuilt.warnings).toEqual([]);
    const { arena: importedArena } = await exportStepArena(
      adapter,
      imported.document,
      imported.bodyId
    );
    expectRoundedBoxGeometryPreserved(originalArena, importedArena);
    // Steiner: the inner box Minkowski-summed with a radius-2 ball. Extend
    // B20's existing 1e-6 relative measurement target to each representation;
    // approximate integrals need not be identical after STEP reparameterizes it.
    const radius = 2;
    const a = 40 - 2 * radius;
    const b = 30 - 2 * radius;
    const c = 20 - 2 * radius;
    const exactVolume =
      a * b * c +
      2 * radius * (a * b + b * c + a * c) +
      Math.PI * radius ** 2 * (a + b + c) +
      (4 / 3) * Math.PI * radius ** 3;
    for (const measured of [
      rounded.volume,
      rebuilt.bodyRepresentations[imported.bodyId]!.volume
    ]) {
      expect(Math.abs(measured - exactVolume) / exactVolume).toBeLessThan(1e-6);
    }
  });

  it('includes the entire local inventory even when the provider digest is truncated', () => {
    const bodyId = box.bodyOrder[0]!;
    const body = box.derived.bodyRepresentations[bodyId]!;
    const topology = body.topology!;
    const expanded = {
      ...box,
      derived: {
        ...box.derived,
        bodyRepresentations: {
          [bodyId]: {
            ...body,
            topology: {
              ...topology,
              edges: Array.from({ length: 96 }, (_, index) => ({
                ...topology.edges[0]!,
                topologyId: `edge:${index}`,
                hash: index + 1
              }))
            }
          }
        }
      }
    };
    expect(
      createCadDocumentDigest(expanded).bodies?.[0]?.topology
        ?.edgeInventoryComplete
    ).toBe(false);
    const proposal = createAllEdgesFilletProposal(
      expanded,
      selection,
      'Fillet all edges'
    )!.proposal!;
    const operation = proposal.operations[0]!;
    expect(
      operation.kind === 'add_edge_modifier' && operation.edgeHashes
    ).toHaveLength(96);
  });

  it('resolves one selected part or an explicit name, and refuses ambiguity', () => {
    const bodyId = box.bodyOrder[0]!;
    const body = box.derived.bodyRepresentations[bodyId]!;
    const anotherId = 'body_other' as typeof bodyId;
    const twoBodies = {
      ...box,
      derived: {
        ...box.derived,
        bodyRepresentations: {
          [bodyId]: body,
          [anotherId]: { ...body, bodyId: anotherId, name: 'Lid Body' }
        }
      }
    };
    expect(
      createAllEdgesFilletProposal(twoBodies, selection, 'Fillet all edges')
        ?.error
    ).toContain('Select one part');
    const selected = { ...selection, bodyIds: [anotherId] };
    expect(
      createAllEdgesFilletProposal(twoBodies, selected, 'Fillet all edges')
        ?.proposal?.operations[0]
    ).toMatchObject({ targetBodyId: anotherId });
    expect(
      createAllEdgesFilletProposal(
        twoBodies,
        selected,
        'Fillet all edges of Block'
      )?.proposal?.operations[0]
    ).toMatchObject({ targetBodyId: bodyId });
    expect(
      createAllEdgesFilletProposal(
        twoBodies,
        { ...selection, bodyIds: [bodyId, anotherId] },
        'Fillet all edges'
      )?.error
    ).toContain('Select one part');
  });

  it('excludes periodic seams and converts explicit length units', async () => {
    const cylinder = addPrimitiveFeature(
      createProjectDocument('Cylinder', toUserId('user_fillet'), 'cm'),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 4 }
      }
    );
    const built = {
      ...cylinder,
      derived: await adapter.syncDocument(cylinder)
    };
    const proposal = createAllEdgesFilletProposal(
      built,
      selection,
      'Fillet all edges by 1 mm'
    )!.proposal!;
    const operation = proposal.operations[0]!;
    expect(operation).toMatchObject({ size: 0.1 });
    expect(
      operation.kind === 'add_edge_modifier' && operation.edgeHashes
    ).toHaveLength(2);
  });

  it('rejects a nonpositive radius and a body without exact topology', () => {
    expect(
      createAllEdgesFilletProposal(box, selection, 'Fillet all edges by -1 mm')
        ?.error
    ).toContain('positive');
    const bodyId = box.bodyOrder[0]!;
    const body = box.derived.bodyRepresentations[bodyId]!;
    const mesh = {
      ...box,
      derived: {
        ...box.derived,
        bodyRepresentations: {
          [bodyId]: { ...body, topology: undefined }
        }
      }
    };
    expect(
      createAllEdgesFilletProposal(mesh, selection, 'Fillet all edges')?.error
    ).toContain('exact solid edges');
  });

  it.each([1, 10])(
    'preflights an imported concave bracket at radius %s without changing the source',
    async (radius) => {
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      let step: string;
      try {
        const profile = kernel.makePolygon(
          new Float64Array([
            0, 0, 0, 40, 0, 0, 40, 8, 0, 8, 8, 0, 8, 50, 0, 0, 50, 0
          ])
        );
        const solid = kernel.extrude(profile, 0, 0, 1, 20);
        step = new TextDecoder().decode(
          io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
        );
      } finally {
        kernel.free();
      }
      const imported = importStepBody(
        createProjectDocument('Bracket', toUserId('user_fillet')),
        {
          name: 'Bracket',
          artifactId: 'bracket',
          sourceName: 'bracket.step',
          stepText: step
        }
      );
      const base = {
        ...imported.document,
        derived: await adapter.syncDocument(imported.document)
      };
      const original = JSON.stringify(base);
      const result = createAllEdgesFilletProposal(
        base,
        selection,
        `Fillet all edges by ${radius} mm`
      );
      expect(result?.error).toBeUndefined();
      const preflight = preflightCadPatch(
        base,
        result!.proposal!,
        (candidate) => adapter.syncDocument(candidate)
      );
      if (radius === 10) {
        await expect(preflight).rejects.toThrow(/corner|blend|fillet|radius/i);
      } else {
        const preview = await preflight;
        expect(preview.candidate.derived.warnings).toEqual([]);
        expect(preview.candidate.derived.exportableBodyIds).toHaveLength(1);
        const bodyId = preview.candidate.derived.exportableBodyIds[0]!;
        const rounded = preview.candidate.derived.bodyRepresentations[bodyId]!;
        const surfaces = rounded.topology!.faces.map(
          (face) => face.geometry?.surfaceType
        );
        expect(surfaces.filter((type) => type === 'plane')).toHaveLength(8);
        expect(surfaces.filter((type) => type === 'cylinder')).toHaveLength(18);
        expect(surfaces.filter((type) => type === 'sphere')).toHaveLength(10);
        expect(surfaces.filter((type) => type === 'torus')).toHaveLength(2);
        // The upstream mixed-notch qualification pins this closed-form volume.
        expect(Math.abs(rounded.volume - 13027.2829)).toBeLessThan(2);
        const step = await adapter.exportStep(preview.candidate, [bodyId]);
        const roundTrip = importStepBody(
          createProjectDocument('Rounded bracket', toUserId('user_fillet')),
          {
            name: 'Rounded bracket',
            artifactId: 'rounded-bracket',
            sourceName: 'rounded.step',
            stepText: step
          }
        );
        const rebuilt = await adapter.syncDocument(roundTrip.document);
        expect(rebuilt.warnings).toEqual([]);
        expect(
          Math.abs(
            rebuilt.bodyRepresentations[roundTrip.bodyId]!.volume -
              rounded.volume
          )
        ).toBeLessThan(0.5);
      }
      expect(JSON.stringify(base)).toBe(original);
      expect((await adapter.syncDocument(base)).warnings).toEqual([]);
    }
  );
});
