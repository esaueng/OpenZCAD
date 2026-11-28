import { describe, expect, it } from 'vitest';
import {
  modelingOperationRefusal,
  operationErrorCategory
} from './remus-operation-refusal';
import { SEALED_CAVITY_REASON, kernelRefusalRecordOf } from './kernel-refusal';

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

// Issues #2384 and #2386. The kernel text is the pinned Remus's, which
// `sealed-cavity-refusal.test.ts` reads off the real kernel.
describe('a refusal for a sealed internal cavity', () => {
  it.each([
    [
      'split',
      'split: unsupported configuration: solid has 1 cavity shell(s); split only operates on the outer shell'
    ],
    [
      'draft',
      'draft: unsupported configuration: solid has 2 cavity shell(s); draft only operates on the outer shell'
    ],
    [
      'shell',
      'shell: unsupported configuration: solid has 1 cavity shell(s); this engine rebuilds only the outer shell'
    ]
  ])('records the cause for a refused %s', (operation, message) => {
    const refusal = modelingOperationRefusal(
      operation,
      new Error(message),
      message
    );
    expect(refusal.message).toBe(message);
    expect(kernelRefusalRecordOf(refusal)).toEqual({
      family: 'modeling',
      category: 'unsupported',
      code: `${operation}_refused`,
      reason: SEALED_CAVITY_REASON
    });
  });

  it('records no cause the kernel did not state', () => {
    for (const message of [
      'draft: unsupported configuration: corner 139 of a drafted face also lies on a curved face',
      'split: unsupported configuration: the cutting plane crosses curved edge 36',
      'offset of solids with cavity shells requires the cavities to stay disjoint'
    ]) {
      expect(
        kernelRefusalRecordOf(
          modelingOperationRefusal('draft', new Error(message), message)
        )?.reason
      ).toBeUndefined();
    }
  });

  it("keeps a cause the caller read over the kernel's sentence", () => {
    const message =
      'split: unsupported configuration: solid has 1 cavity shell(s); split only operates on the outer shell';
    expect(
      kernelRefusalRecordOf(
        modelingOperationRefusal(
          'split',
          new Error(message),
          message,
          'modeling',
          'plane_on_face'
        )
      )?.reason
    ).toBe('plane_on_face');
  });
});
