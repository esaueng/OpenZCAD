import { describe, expect, it } from 'vitest';
import {
  GeometryWorkerError,
  refusalOfWorkerError,
  workerRefusalOf
} from './workerRefusal';

/** Shaped like the adapter's `AdapterRefusal('reference_missing')`. */
function lostReference(message: string): Error {
  return Object.assign(new Error(message), {
    family: 'reference',
    category: 'invalid_input',
    kernelCode: 'reference_missing'
  });
}

describe('worker refusals', () => {
  it('reads a refusal at the error or along its cause chain', () => {
    expect(workerRefusalOf(lostReference('gone'))).toEqual({
      family: 'reference',
      category: 'invalid_input',
      code: 'reference_missing'
    });
    const wrapped = new Error('Feature "Chamfer": gone', {
      cause: new Error('wrapper', { cause: lostReference('gone') })
    });
    expect(workerRefusalOf(wrapped)?.code).toBe('reference_missing');
  });

  it('leaves an untyped failure untyped', () => {
    expect(workerRefusalOf(new Error('worker crashed'))).toBeUndefined();
    expect(workerRefusalOf('text')).toBeUndefined();
  });

  it('keeps the code on the client-side rejection', () => {
    const error = new GeometryWorkerError('The selected face no longer exists.', {
      family: 'reference',
      category: 'invalid_input',
      code: 'reference_missing'
    });
    expect(error.message).toBe('The selected face no longer exists.');
    expect(refusalOfWorkerError(error)?.code).toBe('reference_missing');
    expect(refusalOfWorkerError(new Error('plain'))).toBeUndefined();
  });
});
