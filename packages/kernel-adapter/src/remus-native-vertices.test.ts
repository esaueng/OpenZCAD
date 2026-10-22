import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toBodyId,
  toFeatureId,
  toUserId,
  type RuntimeVertexUnavailableReason
} from '@openzcad/shared';
import { RemusKernel } from './remus-runtime';
import {
  buildPrimitiveLineage,
  patternJournalBoundaryOutputs,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  decodeRemusPatternJournal,
  deriveRemusPatternInstanceLineage
} from './remus-lineage';
import { qualifyGridNativeVertices } from './remus-native-vertices';
import { edgeVertexCandidatesForShape } from './exact-shape-utils';
import { resolveEdgeVertex } from './face-attachment';
import { edgeEndPoint } from './topology-fingerprint';
import {
  cloneBuildState,
  measurementProvenanceKey
} from './exact-history-cache';
import type { ExactBuildResult } from './exact-types';

function fixture(kind: 'box' | 'cylinder' = 'box', scale = 1) {
  const kernel = new RemusKernel();
  const doc = addPrimitiveFeature(
    createProjectDocument('Vertices', toUserId('vertices')),
    {
      name: 'Block',
      primitiveKind: kind,
      dimensions:
        kind === 'box'
          ? { width: 10, height: 10, depth: 10 }
          : { radius: 10, height: 10 }
    }
  );
  const source =
    kind === 'box' ? kernel.makeBox(10, 10, 10) : kernel.makeCylinder(10, 10);
  if (scale !== 1)
    kernel.transformSolid(
      source,
      Float64Array.from([
        scale,
        0,
        0,
        0,
        0,
        scale,
        0,
        0,
        0,
        0,
        scale,
        0,
        0,
        0,
        0,
        1
      ])
    );
  const sourceLineage = buildPrimitiveLineage(
    kernel,
    source,
    listFeaturesInOrder(doc)[0]!
  );
  const journal = decodeRemusPatternJournal(
    kernel.gridPatternJournaled(source, 1, 0, 0, 0, 1, 0, 30, 40, 2, 2)
  );
  const solids = Array.from(kernel.getCompoundSolids(journal.compound));
  const outputs = patternJournalBoundaryOutputs(kernel, journal.op, solids)!;
  const instances = solids.map((solid, index) => ({
    solid,
    instance: `${index % 2}-${Math.floor(index / 2)}`,
    matrix: [
      1,
      0,
      0,
      (index % 2) * 30,
      0,
      1,
      0,
      Math.floor(index / 2) * 40,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1
    ],
    journalVertices: outputs.vertices![index]!
  }));
  const producingFeatureId = toFeatureId('grid');
  const resultLineage = deriveRemusPatternInstanceLineage({
    producingFeatureId,
    sourceLineage,
    sourceCandidates: topologyCandidatesForSolid(kernel, source),
    instances: instances.map((instance, index) => ({
      instance: instance.instance,
      matrix: instance.matrix,
      candidates: topologyCandidatesForSolid(kernel, instance.solid),
      journalEdges: outputs.edges[index]!
    }))
  });
  return {
    kernel,
    source,
    sourceLineage,
    journal,
    solids,
    input: {
      kernel,
      producingFeatureId,
      sourceSolid: source,
      sourceLineage,
      resultLineage,
      instances
    }
  };
}

describe('native grid construction evidence', () => {
  it('carries native proof containers across prefix checkpoints and binds measurement reuse to their identity', () => {
    const f = fixture();
    try {
      const nativeVertices = qualifyGridNativeVertices(f.input);
      const shape = {
        solids: f.solids,
        lineage: f.input.resultLineage,
        nativeVertices
      };
      const bodyId = toBodyId('grid');
      const result: ExactBuildResult = {
        shapes: new Map([[bodyId, shape]]),
        sketchBases: new Map(),
        datumFrames: new Map(),
        datumAxes: new Map(),
        consumed: new Set(),
        importedStepDiagnostics: new Map(),
        meshBodies: new Set(),
        partialRevolveBodies: new Set(),
        warnings: [],
        featureWarnings: [],
        referenceRepairs: []
      };
      const cloned = cloneBuildState(result).shapes.get(bodyId)!;
      expect(cloned.nativeVertices).toEqual(nativeVertices);
      expect(cloned.nativeVertices?.bySolid).not.toBe(nativeVertices.bySolid);
      expect(cloned.nativeVertices?.bySolid.get(f.source)).not.toBe(
        nativeVertices.bySolid.get(f.source)
      );
      expect(cloned.nativeVertices?.withheldBySolid.get(f.source)).not.toBe(
        nativeVertices.withheldBySolid.get(f.source)
      );
      expect(
        cloned.nativeVertices?.bySolid.get(f.source)?.get(0)?.witness.position
      ).not.toBe(
        nativeVertices.bySolid.get(f.source)?.get(0)?.witness.position
      );
      expect(measurementProvenanceKey(shape, undefined)).not.toBe(
        measurementProvenanceKey(
          { ...shape, nativeVertices: undefined },
          undefined
        )
      );
      expect(measurementProvenanceKey(cloned, undefined)).toBe(
        measurementProvenanceKey(shape, undefined)
      );
      const originalKey = measurementProvenanceKey(shape, undefined);
      nativeVertices.bySolid.get(f.source)!.get(0)!.lineageName += '.changed';
      expect(measurementProvenanceKey(shape, undefined)).not.toBe(originalKey);
      expect(measurementProvenanceKey(cloned, undefined)).toBe(originalKey);
      const reasons = new Map<number, RuntimeVertexUnavailableReason>([
        [0, 'event-budget']
      ]);
      const unavailable = {
        ...shape,
        nativeVertices: {
          bySolid: new Map([[f.source, new Map()]]),
          withheldBySolid: new Map([[f.source, reasons]])
        }
      };
      const budgetKey = measurementProvenanceKey(unavailable, undefined);
      reasons.set(0, 'journal-unavailable');
      expect(measurementProvenanceKey(unavailable, undefined)).not.toBe(
        budgetKey
      );
    } finally {
      f.kernel.free();
    }
  });

  it('withholds seam vertex names on closed native cylinder rims', () => {
    const f = fixture('cylinder');
    try {
      expect(f.kernel.getSolidVertices(f.source)).toHaveLength(2);
      expect(f.sourceLineage.edgeReferences.size).toBe(2);
      expect(
        [...f.sourceLineage.edgeReferences.values()].every(
          (reference) => reference.witness.closed
        )
      ).toBe(true);
      const refs = qualifyGridNativeVertices(f.input);
      expect([...refs.bySolid.values()].every((map) => map.size === 0)).toBe(
        true
      );
      expect([...refs.withheldBySolid.values()].map((map) => map.size)).toEqual(
        [2, 2, 2, 2]
      );
    } finally {
      f.kernel.free();
    }
  });

  it('never welds distinct native vertices within one frozen fingerprint quantum', () => {
    const f = fixture('box', 1e-8);
    try {
      const handles = Array.from(f.kernel.getSolidVertices(f.source));
      expect(handles).toHaveLength(8);
      expect(new Set(handles).size).toBe(8);
      const keys = handles.map((handle) =>
        Array.from(f.kernel.getVertexPosition(handle), (value) =>
          Math.round(value * 1e6)
        ).join(',')
      );
      expect(new Set(keys).size).toBe(1);
      expect(
        [...qualifyGridNativeVertices(f.input).bySolid.values()].every(
          (map) => map.size === 0
        )
      ).toBe(true);
    } finally {
      f.kernel.free();
    }
  });
  it('coalesces all three consistent corner anchors, including native handle zero', () => {
    const f = fixture();
    try {
      const state = qualifyGridNativeVertices(f.input);
      expect(Array.from(f.kernel.getSolidVertices(f.source))).toContain(0);
      expect(state.bySolid.get(f.source)?.has(0)).toBe(true);
      expect([...state.bySolid.values()].map((refs) => refs.size)).toEqual([
        8, 8, 8, 8
      ]);
      const corner = [...state.bySolid.get(f.source)!.values()].find((ref) =>
        ref.witness.position.every((value) => value === 0)
      )!;
      expect(corner).toBeDefined();
      expect(corner.lineageName.match(/primitive\.box\.edge\./g)).toHaveLength(
        3
      );
    } finally {
      f.kernel.free();
    }
  });

  it('is independent of native endpoint, edge, vertex and member enumeration order', () => {
    const f = fixture();
    try {
      const before = qualifyGridNativeVertices(f.input);
      const vertices = f.kernel.getSolidVertices.bind(f.kernel);
      const edges = f.kernel.getSolidEdges.bind(f.kernel);
      const handles = f.kernel.getEdgeVertexHandles.bind(f.kernel);
      const endpoints = f.kernel.getEdgeVertices.bind(f.kernel);
      vi.spyOn(f.kernel, 'getSolidVertices').mockImplementation((solid) =>
        Uint32Array.from(vertices(solid)).reverse()
      );
      vi.spyOn(f.kernel, 'getSolidEdges').mockImplementation((solid) =>
        Uint32Array.from(edges(solid)).reverse()
      );
      vi.spyOn(f.kernel, 'getEdgeVertexHandles').mockImplementation((edge) =>
        Uint32Array.from(handles(edge)).reverse()
      );
      vi.spyOn(f.kernel, 'getEdgeVertices').mockImplementation((edge) => {
        const values = endpoints(edge);
        return Float64Array.from([...values.slice(3), ...values.slice(0, 3)]);
      });
      const after = qualifyGridNativeVertices({
        ...f.input,
        instances: [...f.input.instances].reverse()
      });
      for (const solid of f.solids)
        expect([...after.bySolid.get(solid)!].sort()).toEqual(
          [...before.bySolid.get(solid)!].sort()
        );
    } finally {
      f.kernel.free();
    }
  });

  it('requires every supported incident claim rather than taking two agreeing anchors', () => {
    const f = fixture();
    try {
      const edge = f.kernel.getSolidEdges(f.source)[0]!;
      const ends = new Set(f.kernel.getEdgeVertexHandles(edge));
      f.input.resultLineage.edgeReferences.delete(edge);
      const refs = qualifyGridNativeVertices(f.input).bySolid.get(f.source)!;
      expect(refs.size).toBe(6);
      for (const vertex of ends) expect(refs.has(vertex)).toBe(false);
    } finally {
      f.kernel.free();
    }
  });

  it('withholds the ends of an explicitly stale source edge', () => {
    const f = fixture();
    try {
      const edge = f.kernel.getSolidEdges(f.source)[0]!;
      f.sourceLineage.edgeReferences.get(edge)!.currentHash += 1;
      expect(
        [...qualifyGridNativeVertices(f.input).bySolid.values()].map(
          (refs) => refs.size
        )
      ).toEqual([6, 6, 6, 6]);
    } finally {
      f.kernel.free();
    }
  });

  it.each([
    'wrong-kind',
    'bound-many',
    'inferred',
    'stale',
    'duplicate',
    'foreign',
    'truncated',
    'phantom-sentinel',
    'malformed'
  ])('rejects %s vertex subjects while preserving the edge census', (mode) => {
    const f = fixture();
    try {
      const resolve = f.kernel.resolveOperationOutput.bind(f.kernel);
      const first = f.kernel.getSolidVertices(f.source)[0]!;
      vi.spyOn(f.kernel, 'resolveOperationOutput').mockImplementation(
        (op, kind, index) => {
          if (kind !== 'vertex') return resolve(op, kind, index);
          if (mode === 'malformed') return '{';
          if (mode === 'stale')
            return JSON.stringify({ status: 'unknownOperation' });
          if (mode === 'truncated' && index === 31)
            return JSON.stringify({ status: 'noMatch' });
          if (mode === 'phantom-sentinel' && index === 32)
            return JSON.stringify({
              status: 'bound',
              provenance: 'construction',
              entities: [{ kind: 'vertex', handle: first }]
            });
          if (index >= 32) return resolve(op, kind, index);
          const row = JSON.parse(resolve(op, kind, index)) as {
            status: string;
            provenance: string;
            entities: { kind: string; handle: number }[];
          };
          if (mode === 'wrong-kind') row.entities[0]!.kind = 'edge';
          if (mode === 'bound-many') row.status = 'boundMany';
          if (mode === 'inferred') row.provenance = 'inferred';
          if (mode === 'duplicate') row.entities[0]!.handle = first;
          if (mode === 'foreign') row.entities[0]!.handle = 4_000_000_000;
          return JSON.stringify(row);
        }
      );
      const result = patternJournalBoundaryOutputs(
        f.kernel,
        f.journal.op,
        f.solids
      );
      expect(result?.edges.map((set) => set.size)).toEqual([12, 12, 12, 12]);
      expect(result?.vertices).toBeNull();
      expect(result?.vertexUnavailableReason).toBe('journal-unavailable');
    } finally {
      f.kernel.free();
    }
  });

  it('qualifies vertex subjects without using their public output order as source identity', () => {
    const f = fixture();
    try {
      const resolve = f.kernel.resolveOperationOutput.bind(f.kernel);
      vi.spyOn(f.kernel, 'resolveOperationOutput').mockImplementation(
        (op, kind, index) =>
          resolve(
            op,
            kind,
            kind === 'vertex' && index < 32 ? 31 - index : index
          )
      );
      const result = patternJournalBoundaryOutputs(
        f.kernel,
        f.journal.op,
        f.solids
      )!;
      const input = {
        ...f.input,
        instances: f.input.instances.map((instance, index) => ({
          ...instance,
          journalVertices: result.vertices![index]!
        }))
      };
      expect(
        [...qualifyGridNativeVertices(input).bySolid.values()].map(
          (refs) => refs.size
        )
      ).toEqual([8, 8, 8, 8]);
    } finally {
      f.kernel.free();
    }
  });
});

describe('R01 native point consumption with legacy endpoint compatibility', () => {
  it.each([0, 1] as const)(
    'uses the actual qualified native point for canonical end %s',
    (end) => {
      const f = fixture();
      try {
        const state = qualifyGridNativeVertices(f.input);
        const candidates = edgeVertexCandidatesForShape(f.kernel, {
          solids: f.solids,
          lineage: f.input.resultLineage,
          nativeVertices: state
        });
        const edge = f.kernel.getSolidEdges(f.source)[0]!;
        const reference = f.input.resultLineage.edgeReferences.get(edge)!;
        const candidate = candidates.find(
          (item) => item.lineage?.identity.lineageName === reference.lineageName
        )!;
        const point = edgeEndPoint(candidate.endpoints!, end);
        const index = point === candidate.endpoints![0] ? 0 : 1;
        const evidence = candidate.nativeEndpoints![index]!;
        expect(evidence.status).toBe('qualified');
        if (evidence.status !== 'qualified')
          throw new Error('Expected native fixture');
        // Inside the unchanged ADR-011 quantum, native coordinates remain the
        // actual point authority. Returning the curve endpoint would lose it.
        const native = {
          ...evidence,
          point: { ...evidence.point, x: evidence.point.x + 1e-9 }
        };
        const endpoints = [...candidate.nativeEndpoints!] as [
          typeof evidence,
          typeof evidence
        ];
        endpoints[index] = native;
        const input = {
          reference,
          end,
          candidates: [{ ...candidate, nativeEndpoints: endpoints }],
          datumName: 'Through corner',
          sourceFeatureName: 'Field'
        };
        expect(resolveEdgeVertex(input)).toEqual(native.point);
        expect(
          resolveEdgeVertex({
            ...input,
            candidates: [{ ...candidate, nativeEndpoints: undefined }]
          })
        ).toEqual(point);
      } finally {
        f.kernel.free();
      }
    }
  );

  it('refuses contradictory advertised native evidence instead of falling back', () => {
    const f = fixture();
    try {
      const state = qualifyGridNativeVertices(f.input);
      const candidates = edgeVertexCandidatesForShape(f.kernel, {
        solids: f.solids,
        lineage: f.input.resultLineage,
        nativeVertices: state
      });
      const reference = f.input.resultLineage.edgeReferences
        .values()
        .next().value!;
      const candidate = candidates.find(
        (item) => item.lineage?.identity.lineageName === reference.lineageName
      )!;
      expect(() =>
        resolveEdgeVertex({
          reference,
          end: 0,
          candidates: [
            {
              ...candidate,
              nativeEndpoints: [
                { status: 'unavailable', reason: 'stale-evidence' },
                { status: 'unavailable', reason: 'stale-evidence' }
              ]
            }
          ],
          datumName: 'Through corner',
          sourceFeatureName: 'Field'
        })
      ).toThrow(/Through corner.*native vertex evidence.*stale-evidence/);
    } finally {
      f.kernel.free();
    }
  });

  it.each(['nonfinite', 'truncated'] as const)(
    'turns %s advertised vertex witnesses into a named refusal',
    (fault) => {
      const f = fixture();
      try {
        const state = qualifyGridNativeVertices(f.input);
        for (const reference of state.bySolid.get(f.source)!.values()) {
          if (fault === 'nonfinite') reference.witness.position[0] = NaN;
          else reference.witness.position.pop();
        }
        const candidates = edgeVertexCandidatesForShape(f.kernel, {
          solids: f.solids,
          lineage: f.input.resultLineage,
          nativeVertices: state
        });
        const reference = f.input.resultLineage.edgeReferences.get(
          f.kernel.getSolidEdges(f.source)[0]!
        )!;
        expect(() =>
          resolveEdgeVertex({
            reference,
            end: 0,
            candidates,
            datumName: 'Broken corner',
            sourceFeatureName: 'Field'
          })
        ).toThrow(/Broken corner.*native vertex evidence.*stale-evidence/);
      } finally {
        f.kernel.free();
      }
    }
  );
});
