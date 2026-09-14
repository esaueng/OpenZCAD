import { describe, expect, it } from 'vitest';
import type { FeatureId } from '@openzcad/shared';

import { RemusKernel } from './remus-runtime';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { unifyBooleanFaces, unifyUnionFaces } from './exact-boolean-helpers';
import {
  declinedBooleanEvidence,
  deriveBooleanLineage,
  probeBooleanEntityEvolution
} from './exact-boolean-evolution';
import {
  createRemusSemanticLineage,
  type RemusBooleanOperand,
  type RemusTopologyCandidate
} from './remus-lineage';

const FEATURE_ID = 'feature_boolean_probe' as FeatureId;

function rowMajor(tx: number, ty: number, tz: number): Float64Array {
  return new Float64Array([1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]);
}

function namedOperand(
  kernel: RemusKernel,
  solid: number,
  prefix: string,
  role: 'target' | 'tool'
): RemusBooleanOperand {
  const candidates = topologyCandidatesForSolid(kernel, solid);
  return {
    role,
    candidates,
    lineage: createRemusSemanticLineage(
      FEATURE_ID,
      'primitive',
      candidates.map((candidate: RemusTopologyCandidate, index: number) => ({
        ...candidate,
        lineageName: `${prefix}.${candidate.kind}.${index}`
      }))
    )
  };
}

/**
 * The probe is the whole point of the redesign: the shipped body comes from
 * the plain entry point, and the kernel's entity-evolution payload is believed
 * only where a second, independent body proves it describes the same
 * operation.
 */
describe('probeBooleanEntityEvolution', () => {
  it('accepts the payload where the evolution call lands on the shipped body', () => {
    const kernel = new RemusKernel();
    const plate = kernel.makeBox(40, 24, 10);
    const tool = kernel.makeBox(10, 6, 8);
    kernel.transformSolid(tool, rowMajor(15, 9, 6));
    const operands = [
      namedOperand(kernel, plate, 'plate', 'target'),
      namedOperand(kernel, tool, 'tool', 'tool')
    ];
    const shipped = unifyBooleanFaces(kernel, kernel.cut(plate, tool));
    const evidence = probeBooleanEntityEvolution({
      kernel,
      operation: 'cut',
      a: plate,
      b: tool,
      shipped,
      unify: (candidate) => unifyBooleanFaces(kernel, candidate),
      operands
    });
    expect(evidence.declined).toBeNull();
    expect(evidence.evolution).not.toBeNull();
    // The payload addresses the probe's own body, never the shipped one.
    expect(evidence.evolution!.solid).not.toBe(shipped);
    const lineage = deriveBooleanLineage({
      evidence,
      producingFeatureId: FEATURE_ID,
      operands,
      resultCandidates: topologyCandidatesForSolid(kernel, shipped)
    });
    const names = [...lineage.faceReferences.values()].map(
      (reference) => reference.lineageName
    );
    expect(names.some((name) => name.startsWith('boolean.face.target.'))).toBe(
      true
    );
    // Every published reference names a face of the SHIPPED body.
    const shippedFaces = new Set(Array.from(kernel.getSolidFaces(shipped)));
    for (const handle of lineage.faceReferences.keys()) {
      expect(shippedFaces.has(handle)).toBe(true);
    }
  });

  it('declines where the evolution fuse lands on a different body', () => {
    // Measured on the pin: the plain fuse of these two cylinders has six
    // faces, the evolution fuse five. Same volume, different topology — and a
    // payload that partitions a different body is not evidence about this one.
    const kernel = new RemusKernel();
    const base = kernel.makeCylinder(20, 5);
    const post = kernel.makeCylinder(5, 20);
    kernel.transformSolid(post, rowMajor(0, 0, 5));
    const operands = [
      namedOperand(kernel, base, 'base', 'target'),
      namedOperand(kernel, post, 'post', 'tool')
    ];
    const shipped = unifyUnionFaces(
      kernel,
      kernel.fuseAll(Uint32Array.from([base, post]))
    );
    expect(kernel.getSolidFaces(shipped).length).toBe(6);
    const evidence = probeBooleanEntityEvolution({
      kernel,
      operation: 'fuse',
      a: base,
      b: post,
      shipped,
      unify: (candidate) => unifyUnionFaces(kernel, candidate),
      operands
    });
    expect(evidence.evolution).toBeNull();
    expect(evidence.declined).toMatch(/did not reproduce the body/);
    // And the geometry is untouched by the refusal.
    expect(kernel.getSolidFaces(shipped).length).toBe(6);
  });

  it('declines where the evolution call refuses a boolean the plain call performs', () => {
    // `cutWithEntityEvolution` throws `assembly failed: closed hole shell is
    // not contained by any growth region` here, while the plain cut builds a
    // five-face body. The cut must still ship.
    const kernel = new RemusKernel();
    const cylinder = kernel.makeCylinder(10, 20);
    const sphere = kernel.makeSphere(8, 32);
    kernel.transformSolid(sphere, rowMajor(0, 0, 10));
    const operands = [
      namedOperand(kernel, cylinder, 'cylinder', 'target'),
      namedOperand(kernel, sphere, 'sphere', 'tool')
    ];
    const shipped = unifyBooleanFaces(kernel, kernel.cut(cylinder, sphere));
    expect(kernel.getSolidFaces(shipped).length).toBe(5);
    const evidence = probeBooleanEntityEvolution({
      kernel,
      operation: 'cut',
      a: cylinder,
      b: sphere,
      shipped,
      unify: (candidate) => unifyBooleanFaces(kernel, candidate),
      operands
    });
    expect(evidence.evolution).toBeNull();
    expect(evidence.declined).toMatch(/did not produce a usable payload/);
    expect(kernel.getSolidFaces(shipped).length).toBe(5);
  });

  it('falls back to carrier lineage and records why when evidence is declined', () => {
    const kernel = new RemusKernel();
    const plate = kernel.makeBox(40, 24, 10);
    const tool = kernel.makeBox(10, 6, 8);
    kernel.transformSolid(tool, rowMajor(15, 9, 6));
    const operands = [
      namedOperand(kernel, plate, 'plate', 'target'),
      namedOperand(kernel, tool, 'tool', 'tool')
    ];
    const shipped = unifyBooleanFaces(kernel, kernel.cut(plate, tool));
    const resultCandidates = topologyCandidatesForSolid(kernel, shipped);
    const lineage = deriveBooleanLineage({
      evidence: declinedBooleanEvidence('the probe was not run'),
      producingFeatureId: FEATURE_ID,
      operands,
      resultCandidates
    });
    expect(
      lineage.diagnostics.some((entry) =>
        entry.message.includes('the probe was not run')
      )
    ).toBe(true);
    // The analytic-carrier rule is untouched by the fallback: it still names
    // what it always named.
    expect(lineage.faceReferences.size).toBeGreaterThan(0);
  });
});
