import { describe, expect, it } from 'vitest';
import {
  decideProjectSync,
  shouldPollForFreshness
} from '../apps/web/src/lib/projectSyncDecision';

const baseline = {
  localVersion: 5,
  accountVersion: 5,
  lastSyncedVersion: 5,
  hasUnsentChanges: false
};

describe('the sync truth table', () => {
  it('says nothing to do when neither side moved', () => {
    expect(decideProjectSync(baseline)).toBe('in-sync');
  });

  it('pushes when only this device moved', () => {
    expect(decideProjectSync({ ...baseline, localVersion: 7 })).toBe('push');
  });

  it('pushes when this device has an unwritten edit at the same version', () => {
    // A device can be dirty without its version having changed yet, so the
    // version comparison alone cannot answer this.
    expect(decideProjectSync({ ...baseline, hasUnsentChanges: true })).toBe(
      'push'
    );
  });

  it('pulls when only the account moved', () => {
    expect(decideProjectSync({ ...baseline, accountVersion: 9 })).toBe('pull');
  });

  it('calls it a conflict when both moved', () => {
    // The case the old version-then-timestamp comparison could not see. It
    // resolved this by dropping one side on the authority of a device clock.
    expect(
      decideProjectSync({
        ...baseline,
        localVersion: 7,
        accountVersion: 9
      })
    ).toBe('conflict');
  });

  it('calls it a conflict when this device is dirty and the account moved', () => {
    expect(
      decideProjectSync({
        ...baseline,
        accountVersion: 9,
        hasUnsentChanges: true
      })
    ).toBe('conflict');
  });

  it('does not mistake equal versions for agreement when both moved to it', () => {
    // Two devices can reach version 7 through different edits. With a baseline
    // of 5, that is divergence, not a match.
    expect(
      decideProjectSync({
        localVersion: 7,
        accountVersion: 7,
        lastSyncedVersion: 5,
        hasUnsentChanges: false
      })
    ).toBe('conflict');
  });
});

describe('a device with no recorded baseline', () => {
  it('refuses to guess when the versions differ', () => {
    // Clearing browser storage loses the baseline. Assuming "behind" would
    // discard local work; assuming "ahead" would discard the account's.
    expect(
      decideProjectSync({
        localVersion: 4,
        accountVersion: 9,
        lastSyncedVersion: null,
        hasUnsentChanges: false
      })
    ).toBe('unknown-baseline');
  });

  it('refuses to guess when there are unwritten edits, even at equal versions', () => {
    expect(
      decideProjectSync({
        localVersion: 5,
        accountVersion: 5,
        lastSyncedVersion: null,
        hasUnsentChanges: true
      })
    ).toBe('unknown-baseline');
  });

  it('refuses to infer content agreement from equal versions', () => {
    expect(
      decideProjectSync({
        localVersion: 5,
        accountVersion: 5,
        lastSyncedVersion: null,
        hasUnsentChanges: false
      })
    ).toBe('unknown-baseline');
  });
});

describe('when a freshness check is worth making', () => {
  const pollable = {
    projectId: 'proj_1',
    signedIn: true,
    accountHoldsProject: true,
    awaitingResolution: false
  };

  it('polls an open cloud project', () => {
    expect(shouldPollForFreshness(pollable)).toBe(true);
  });

  it('does not poll with no project open', () => {
    expect(shouldPollForFreshness({ ...pollable, projectId: null })).toBe(
      false
    );
  });

  it('does not poll while signed out', () => {
    expect(shouldPollForFreshness({ ...pollable, signedIn: false })).toBe(
      false
    );
  });

  it('does not poll a project the account does not hold', () => {
    expect(
      shouldPollForFreshness({ ...pollable, accountHoldsProject: false })
    ).toBe(false);
  });

  it('stops polling once a decision is already pending', () => {
    // A halted controller is waiting on the user. More polling adds noise to a
    // question that is already asked.
    expect(
      shouldPollForFreshness({ ...pollable, awaitingResolution: true })
    ).toBe(false);
  });
});
