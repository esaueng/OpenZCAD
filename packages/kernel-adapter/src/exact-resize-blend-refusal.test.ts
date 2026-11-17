import { describe, expect, it } from 'vitest';
import {
  RESIZE_BLEND_REFUSAL_CATEGORIES,
  resizeBlendRefusalOf,
  withResizeBlendRefusal
} from './exact-resize-blend-refusal';
import { KernelRefusal, kernelRefusalRecordOf } from './kernel-refusal';

describe('blend resize refusals', () => {
  it('types every code the kernel prefixes a resize refusal with', () => {
    for (const [code, category] of Object.entries(
      RESIZE_BLEND_REFUSAL_CATEGORIES
    )) {
      const refusal = resizeBlendRefusalOf(
        new Error(`${code}: resize blend: detail`)
      );
      expect(refusal).toBeInstanceOf(KernelRefusal);
      expect(refusal).toMatchObject({
        family: 'blend',
        category,
        kernelCode: code,
        kernelMessage: 'resize blend: detail',
        message: `${code}: resize blend: detail`
      });
    }
  });

  it('keeps the plane × cone removal the K10 matrix met as unsupported', () => {
    const message =
      'unsupported-support-pair: resize blend: unsupported analytic support pair: plane x cone';
    const thrown = (() => {
      try {
        withResizeBlendRefusal(() => {
          throw new Error(message);
        });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(kernelRefusalRecordOf(thrown)).toEqual({
      family: 'blend',
      category: 'unsupported',
      code: 'unsupported-support-pair'
    });
    // The sentence the build loop shows is unchanged.
    expect((thrown as Error).message).toBe(message);
    // A caller that adds its own context still exposes the record.
    expect(
      kernelRefusalRecordOf(
        new Error('Removing the fillet failed.', { cause: thrown })
      )
    ).toMatchObject({ code: 'unsupported-support-pair' });
  });

  it('leaves errors that carry no resize code alone', () => {
    for (const message of [
      'Blend radius must differ from its current radius.',
      'unknown-code: something',
      ': empty code',
      'radius-too-large'
    ]) {
      const original = new Error(message);
      expect(resizeBlendRefusalOf(original)).toBeNull();
      expect(() =>
        withResizeBlendRefusal(() => {
          throw original;
        })
      ).toThrow(original);
    }
    expect(resizeBlendRefusalOf('radius-too-large: x')).toBeNull();
    expect(withResizeBlendRefusal(() => 7)).toBe(7);
  });
});
