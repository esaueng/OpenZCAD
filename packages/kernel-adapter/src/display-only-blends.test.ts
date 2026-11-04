import { describe, expect, it } from 'vitest';
import type { FeatureNode } from '@openzcad/shared';
import {
  displayOnlyBlendSalt,
  displayOnlyBlendsSupported,
  withDisplayOnlyBlends
} from './display-only-blends';

const feature = (featureKind: string) =>
  ({ data: { featureKind } }) as unknown as FeatureNode;

describe('display-only blend digests', () => {
  it('salts only the features that run kernel blends, only when asked', () => {
    for (const kind of ['fillet', 'chamfer', 'direct-edit']) {
      expect(displayOnlyBlendSalt(feature(kind), true)).not.toBe('');
      expect(displayOnlyBlendSalt(feature(kind), false)).toBe('');
    }
    for (const kind of ['primitive', 'extrude', 'boolean']) {
      expect(displayOnlyBlendSalt(feature(kind), true)).toBe('');
    }
  });
});

describe('display-only blend switch', () => {
  it('holds the kernel switch for the work alone, even when it throws', () => {
    const calls: boolean[] = [];
    const kernel = { setDisplayOnlyBlends: (on: boolean) => calls.push(on) };
    expect(withDisplayOnlyBlends(kernel, true, () => 7)).toBe(7);
    expect(() =>
      withDisplayOnlyBlends(kernel, true, () => {
        throw new Error('build failed');
      })
    ).toThrow('build failed');
    expect(calls).toEqual([true, false, true, false]);
  });

  it('leaves the kernel alone when off or when it has no switch', () => {
    const calls: boolean[] = [];
    const kernel = { setDisplayOnlyBlends: (on: boolean) => calls.push(on) };
    expect(withDisplayOnlyBlends(kernel, false, () => 1)).toBe(1);
    expect(withDisplayOnlyBlends({}, true, () => 2)).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('display-only blend support', () => {
  it('follows whether the kernel class has the switch', () => {
    class WithSwitch {
      setDisplayOnlyBlends(_enabled: boolean) {}
    }
    class WithoutSwitch {}
    expect(displayOnlyBlendsSupported(WithSwitch)).toBe(true);
    expect(displayOnlyBlendsSupported(WithoutSwitch)).toBe(false);
  });
});
