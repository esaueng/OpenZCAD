import { describe, expect, it } from 'vitest';
import { toFeatureId } from '@openzcad/shared';
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
