import { describe, expect, it } from 'vitest';
import { toFeatureId, toUserId } from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  ADAPTER_REFUSALS,
  AdapterRefusal,
  adapterRefusalRecord,
  type AdapterRefusalCode
} from '../packages/kernel-adapter/src/adapter-refusal';
import { BlendRefusal } from '../packages/kernel-adapter/src/exact-blend-refusal';
import { EdgeModifierRefusalError } from '../packages/kernel-adapter/src/exact-edge-modifiers';
import { raiseFeatureWarning } from '../packages/kernel-adapter/src/exact-feature-warnings';
import type { ExactBuildResult } from '../packages/kernel-adapter/src/exact-types';
import { kernelRefusalRecordOf } from '../packages/kernel-adapter/src/kernel-refusal';
import {
  ambiguousReferenceError,
  unresolvedReferenceError
} from '../packages/kernel-adapter/src/topology-fingerprint';
import {
  REFUSAL_CATEGORIES,
  REFUSAL_CODE_PATTERN,
  REFUSAL_FAMILIES,
  REFUSAL_KERNEL_OPERATIONS
} from '../apps/web/src/lib/glimpseContract';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';

/**
 * K10 WS2: refusals the adapter raises itself travel on the same typed
 * `kernelRefusal` record as the kernel's, so the ledgers record them as
 * `typed-refusal` and analytics can bucket them without reading prose.
 */
describe('adapter-raised refusals are typed', () => {
  const codes = Object.keys(ADAPTER_REFUSALS) as AdapterRefusalCode[];

  it('gives every code a record the analytics contract accepts as-is', () => {
    for (const code of codes) {
      const record = adapterRefusalRecord(code);
      expect(record.code).toBe(code);
      expect(code).toMatch(REFUSAL_CODE_PATTERN);
      expect(REFUSAL_FAMILIES).toContain(record.family);
      expect(REFUSAL_CATEGORIES).toContain(record.category);
      if (record.operation !== undefined) {
        expect(REFUSAL_KERNEL_OPERATIONS).toContain(record.operation);
      }
    }
  });

  it('records a thrown adapter refusal, however deeply it was wrapped', () => {
    const refusal = new AdapterRefusal(
      'union_not_solid',
      'Union produced an open, non-manifold, or inconsistently oriented result.'
    );
    const wrapped = new Error('outer context', { cause: refusal });
    expect(kernelRefusalRecordOf(wrapped)).toEqual({
      family: 'boolean',
      operation: 'fuse',
      category: 'invalid_topology',
      code: 'union_not_solid'
    });
    expect(kernelRefusalRecordOf(wrapped)).toEqual(
      adapterRefusalRecord('union_not_solid')
    );
  });

  it('types the lost, positional and ambiguous reference errors', () => {
    const lost = unresolvedReferenceError('edge', 0x9e3779b9, 12);
    expect(lost.message).toBe(
      'A selected edge no longer exists. Re-select the edges and re-create this feature.'
    );
    expect(kernelRefusalRecordOf(lost)?.code).toBe('reference_missing');
    expect(kernelRefusalRecordOf(lost)?.family).toBe('reference');
    expect(
      kernelRefusalRecordOf(unresolvedReferenceError('face', 3, 12))?.code
    ).toBe('reference_positional');
    expect(kernelRefusalRecordOf(ambiguousReferenceError('face'))?.code).toBe(
      'reference_ambiguous'
    );
    // The card still reads a lost selection by its sentence, which stays.
    expect(plainRefusal(lost.message, 'invalid_input').message).toBe(
      lost.message
    );
  });

  it('keeps the adapter sentences the user reads unchanged', () => {
    for (const sentence of [
      'Union does not fill empty space. The selected solids form 2 disconnected groups. Move or extend a body until every solid touches or overlaps.',
      'Radius must be greater than zero.',
      'Blend radius must be zero or greater.',
      'Edge modifier size must be greater than zero.'
    ]) {
      expect(plainRefusal(sentence, 'invalid_input').message).toBe(sentence);
    }
  });

  it('records a union gate raised as a warning rather than thrown', () => {
    const result = {
      warnings: [],
      featureWarnings: []
    } as unknown as ExactBuildResult;
    raiseFeatureWarning(
      result,
      { featureId: toFeatureId('feat_union'), name: 'Union' },
      'Union does not fill empty space.',
      'refusal',
      adapterRefusalRecord('union_disconnected')
    );
    expect(result.featureWarnings[0]?.kernelRefusal).toEqual({
      family: 'boolean',
      operation: 'fuse',
      category: 'invalid_input',
      code: 'union_disconnected'
    });
  });
});

describe('cylinder primitive dimension validation', () => {
  it.each([
    [{ radius: 5, height: 0 }, 'height'],
    [{ radius: 5, height: -3 }, 'height'],
    [{ radius: 0, height: 5 }, 'radius'],
    [{ radius: -3, height: 5 }, 'radius']
  ])('reports a typed refusal for %j', async (dimensions, size) => {
    const adapter = await createExactKernelAdapter();
    try {
      const derived = await adapter.syncDocument(
        addPrimitiveFeature(
          createProjectDocument('Cylinder', toUserId('user_test')),
          { name: 'Post', primitiveKind: 'cylinder', dimensions }
        )
      );
      const [warning] = derived.featureWarnings ?? [];
      expect(warning).toMatchObject({
        kind: 'build-failed',
        kernelRefusal: {
          family: 'validation',
          category: 'invalid_input',
          code: 'cylinder_dimension_not_positive'
        }
      });
      expect(
        plainRefusal(warning!.message, warning!.kernelRefusal).message
      ).toBe(`Feature "Post": The ${size} must be greater than zero.`);
    } finally {
      adapter.dispose();
    }
  });
});

describe('a refused fillet or chamfer carries its classification', () => {
  it("relays the kernel's typed refusal of the requested size", () => {
    const kernel = new BlendRefusal({
      operation: 'fillet',
      category: 'unsupported',
      kernelCode: 'unsupported-vertex-blend',
      kernelMessage: 'the blend engines gave up on vertex 4'
    });
    const error = new EdgeModifierRefusalError(
      'Fillet could not be created on 1 selected edge with radius 3. Try a smaller radius: radius 1.5 builds here.',
      null,
      kernel
    );
    expect(error.message).toMatch(/^Fillet could not be created/);
    expect(kernelRefusalRecordOf(error)).toEqual({
      family: 'blend',
      operation: 'fillet',
      category: 'unsupported',
      code: 'unsupported-vertex-blend'
    });
  });

  describe('a chamfer beside a face with an inner loop', () => {
    const catchAll = (operation: 'chamfer' | 'chamferDistanceAngle') =>
      new BlendRefusal({
        operation,
        category: 'internal',
        kernelCode: 'fillet-failed',
        kernelMessage: 'the shell the chamfer assembled failed validation'
      });
    const reason =
      "A flat face beside this edge has a hole, pocket or boss inside it, which the modeling engine can't chamfer next to yet. Smaller distances failed too. If a separate, later feature made that shape, chamfer the edge before that feature.";
    const message = `Chamfer could not be created on 1 selected edge with distance 1. ${reason}`;
    const advice = (
      cause: 'face-inner-loop' | 'neighbor-faces'
    ): ConstructorParameters<typeof EdgeModifierRefusalError>[1] => ({
      operation: 'chamfer',
      edges: 1,
      reason,
      kind: 'structural',
      cause
    });

    it('refiles the kernel catch-all as a typed unsupported refusal, keeping its code as the reason', () => {
      for (const operation of ['chamfer', 'chamferDistanceAngle'] as const) {
        const error = new EdgeModifierRefusalError(
          message,
          advice('face-inner-loop'),
          catchAll(operation)
        );
        expect(kernelRefusalRecordOf(error)).toEqual({
          family: 'blend',
          operation,
          category: 'unsupported',
          code: 'chamfer_face_inner_loop',
          reason: 'fillet-failed'
        });
      }
    });

    it("keeps the kernel's internal classification for every other cause", () => {
      const error = new EdgeModifierRefusalError(
        message,
        advice('neighbor-faces'),
        catchAll('chamfer')
      );
      expect(kernelRefusalRecordOf(error)).toEqual({
        family: 'blend',
        operation: 'chamfer',
        category: 'internal',
        code: 'fillet-failed'
      });
    });

    it('does not reclassify a kernel refusal that was already typed', () => {
      const typed = new BlendRefusal({
        operation: 'chamfer',
        category: 'invalid_input',
        kernelCode: 'invalid-input',
        kernelMessage: 'edge 7 is not on this solid'
      });
      const error = new EdgeModifierRefusalError(
        message,
        advice('face-inner-loop'),
        typed
      );
      expect(kernelRefusalRecordOf(error)).toEqual({
        family: 'blend',
        operation: 'chamfer',
        category: 'invalid_input',
        code: 'invalid-input'
      });
    });

    it('reaches the card as the adapter sentence, not a category line', () => {
      const error = new EdgeModifierRefusalError(
        message,
        advice('face-inner-loop'),
        catchAll('chamfer')
      );
      expect(plainRefusal(message, kernelRefusalRecordOf(error))).toEqual({
        message,
        category: 'unsupported',
        code: 'chamfer_face_inner_loop'
      });
    });
  });

  it("uses the adapter's code when an acceptance rule declined the result", () => {
    const error = new EdgeModifierRefusalError(
      'Fillet could not be created on 1 selected edge with radius 3. Try a smaller radius.',
      null
    );
    expect(kernelRefusalRecordOf(error)).toEqual({
      family: 'blend',
      category: 'quality_refused',
      code: 'edge_modifier_refused'
    });
  });
});
