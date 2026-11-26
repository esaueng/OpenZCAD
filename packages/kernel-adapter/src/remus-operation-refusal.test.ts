import { describe, expect, it } from 'vitest';
import {
  modelingOperationRefusal,
  operationErrorCategory
} from './remus-operation-refusal';
import { kernelRefusalRecordOf } from './kernel-refusal';

describe('modeling operation refusals', () => {
  it.each([
    [
      'draft: unsupported configuration: corner 139 of a drafted face also lies on a curved face',
      'unsupported'
    ],
    [
      'split: unsupported configuration: the cutting plane crosses curved edge 36',
      'unsupported'
    ],
    ['invalid input: cutting plane does not split the solid', 'invalid_input'],
    [
      'exact-only policy: the exact boolean pipeline could not produce this result',
      'quality_refused'
    ],
    ['non-manifold result', 'invalid_topology'],
    ['empty result: nothing left', 'invalid_topology'],
    ['something the kernel never said before', 'internal']
  ])('files "%s" as %s', (message, category) => {
    expect(operationErrorCategory(message)).toBe(category);
  });

  it('keeps the sentence and exposes the record through a cause chain', () => {
    const kernelError = new Error(
      'draft: unsupported configuration: a blend on a face the draft re-trims'
    );
    const refusal = modelingOperationRefusal(
      'draft',
      kernelError,
      `Remus draft refused: ${kernelError.message}`
    );
    expect(refusal.message).toBe(`Remus draft refused: ${kernelError.message}`);
    expect(
      kernelRefusalRecordOf(new Error('Draft failed.', { cause: refusal }))
    ).toEqual({
      family: 'modeling',
      category: 'unsupported',
      code: 'draft_refused'
    });
  });

  it("records the adapter's cause for a code that covers several", () => {
    const kernelError = new Error(
      "split: unsupported configuration: the cutting plane does not cross the solid's interior; it only touches the body and contains edge 3 of the solid, so there is nothing to split"
    );
    const refusal = modelingOperationRefusal(
      'split',
      kernelError,
      kernelError.message,
      'modeling',
      'plane_on_face'
    );
    expect(refusal.message).toBe(kernelError.message);
    expect(kernelRefusalRecordOf(refusal)).toEqual({
      family: 'modeling',
      category: 'unsupported',
      code: 'split_refused',
      reason: 'plane_on_face'
    });
  });
});
