import { describe, expect, it } from 'vitest';
import { cloudArchivable } from './cloudArchivable';

describe('cloudArchivable', () => {
  const account = new Map([['p-account', 3]]);

  it('is false signed out, even for a project the account holds', () => {
    expect(cloudArchivable(false, 'p-account', account)).toBe(false);
  });

  it('is false signed in while the project is on this device only', () => {
    expect(cloudArchivable(true, 'p-device', account)).toBe(false);
  });

  it('is false with no project open', () => {
    expect(cloudArchivable(true, null, account)).toBe(false);
  });

  it('is true signed in for a project with an account copy', () => {
    expect(cloudArchivable(true, 'p-account', account)).toBe(true);
  });
});
