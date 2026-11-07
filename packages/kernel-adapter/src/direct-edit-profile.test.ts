import { expect, it } from 'vitest';
import {
  beginDirectEditProfile,
  profileDirectEditStage
} from './direct-edit-profile';

it('times real calls with their receiver and restores bindings after a refused operation', () => {
  class Kernel {
    value = 4;
    read(n: number) {
      return this.value + n;
    }
    refuse() {
      throw new Error('typed refusal');
    }
  }
  const original = Object.getOwnPropertyDescriptors(Kernel.prototype);
  const finish = beginDirectEditProfile(Kernel.prototype);
  const kernel = new Kernel();
  expect(kernel.read(3)).toBe(7);
  expect(() => kernel.refuse()).toThrow('typed refusal');
  const profile = finish();
  expect(profile.stages['kernel.read']!.calls).toBe(1);
  expect(profile.stages['kernel.refuse']!.calls).toBe(1);
  expect(Object.getOwnPropertyDescriptors(Kernel.prototype)).toEqual(original);
  kernel.read(3);
  profileDirectEditStage('outside', () => 1);
  expect(profile.stages['kernel.read']!.calls).toBe(1);
  expect(profile.stages.outside).toBeUndefined();
});
