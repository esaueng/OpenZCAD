import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  edgeFingerprint,
  edgeSampleOf,
  legacyEdgeFingerprint
} from './exact-witnesses';
import { RemusKernel } from './remus-runtime';

describe('persisted edge fingerprint domain', () => {
  let kernel: RemusKernel;

  beforeEach(() => {
    kernel = new RemusKernel();
  });

  afterEach(() => {
    kernel.free();
  });

  it('pins the raw-domain hash of a fillet band quarter-arc', () => {
    // One filleted box edge yields a band closed by two open quarter-arcs.
    // Both fingerprint schemes hash the RAW curve domain ([0, TAU] here,
    // while each edge's trimmed span is a quarter period), because the
    // hashes are persisted document identity (ADR-011). Switching either
    // call site to getEdgeParamSpan moves the sampled midpoint and must
    // fail here first.
    const box = kernel.makeBox(30, 20, 8);
    const first = Array.from(kernel.getSolidEdges(box))[0]!;
    const solid = kernel.fillet(box, new Uint32Array([first]), 0.5);
    const arcs = Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
      if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') {
        return false;
      }
      const vertices = Array.from(kernel.getEdgeVertexHandles(edge));
      return vertices.length === 2 && vertices[0] !== vertices[1];
    });
    expect(arcs).toHaveLength(2);
    const hashes = arcs.map((edge) => {
      // Guards the test's own premise: the pin below is only sensitive to
      // a domain switch while the raw domain and the trimmed span differ.
      const raw = Array.from(kernel.getEdgeCurveParameters(edge));
      const span = Array.from(kernel.getEdgeParamSpan(edge));
      expect(span).not.toEqual(raw);
      expect(edgeSampleOf(kernel, edge).closed).toBe(false);
      return {
        fingerprint: edgeFingerprint(kernel, edge),
        legacy: legacyEdgeFingerprint(kernel, edge)
      };
    });
    hashes.sort((left, right) => left.fingerprint - right.fingerprint);
    expect(hashes).toEqual([
      { fingerprint: 2125444546, legacy: 2125444546 },
      { fingerprint: 2143579052, legacy: 2143579052 }
    ]);
  });
});
