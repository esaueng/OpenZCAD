import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  chooseProjectDocument,
  selectProjectDocument
} from '../apps/web/src/lib/localProjectStore';

const owner = toUserId('user_owner');
const base = createProjectDocument('Bracket', owner);

function at(version: number, updatedAt = '2026-01-01T00:00:00.000Z') {
  return {
    ...base,
    version,
    derived: { ...base.derived, updatedAt }
  } satisfies ProjectDocument;
}

describe('choosing between the two copies of a project', () => {
  it('takes whichever copy exists when only one does', () => {
    expect(chooseProjectDocument(at(3), null)).toMatchObject({
      choice: 'local'
    });
    expect(chooseProjectDocument(null, at(3))).toMatchObject({
      choice: 'remote'
    });
    expect(chooseProjectDocument(null, null)).toEqual({ choice: 'none' });
  });

  it('treats equal versions as agreement without consulting a clock', () => {
    const local = at(4, '2026-01-01T00:00:00.000Z');
    const remote = at(4, '2030-01-01T00:00:00.000Z');
    expect(chooseProjectDocument(local, remote, 4)).toMatchObject({
      choice: 'local'
    });
  });

  it('takes the account copy when only the account moved', () => {
    expect(chooseProjectDocument(at(4), at(9), 4)).toMatchObject({
      choice: 'remote'
    });
  });

  it('keeps the device copy when only the device moved', () => {
    expect(chooseProjectDocument(at(9), at(4), 4)).toMatchObject({
      choice: 'local'
    });
  });

  it('reports divergence instead of picking a winner when both moved', () => {
    // The case that used to be settled by comparing timestamps, which discards
    // one side on the authority of a device clock.
    const outcome = chooseProjectDocument(at(7), at(9), 4);
    expect(outcome.choice).toBe('diverged');
    if (outcome.choice === 'diverged') {
      expect(outcome.local.version).toBe(7);
      expect(outcome.remote.version).toBe(9);
    }
  });

  it('reports divergence even when the device is behind the account', () => {
    // Being behind is not the same as being in agreement: a device at 5 with a
    // baseline of 4 has its own unsent edit, whatever the account did.
    expect(chooseProjectDocument(at(5), at(9), 4).choice).toBe('diverged');
  });

  it('falls back to the newer version when no baseline is recorded', () => {
    expect(chooseProjectDocument(at(4), at(9), null)).toMatchObject({
      choice: 'remote'
    });
    expect(chooseProjectDocument(at(9), at(4), null)).toMatchObject({
      choice: 'local'
    });
  });
});

describe('selectProjectDocument', () => {
  it('still answers with a single document for callers that want one', () => {
    expect(selectProjectDocument(at(9), at(4), 4)?.version).toBe(9);
    expect(selectProjectDocument(at(4), at(9), 4)?.version).toBe(9);
    expect(selectProjectDocument(null, null)).toBeNull();
  });

  it('keeps the device copy when it collapses a divergence', () => {
    // Safe, but lossy — which is why callers that can act on divergence are
    // told to use chooseProjectDocument instead.
    expect(selectProjectDocument(at(7), at(9), 4)?.version).toBe(7);
  });
});
