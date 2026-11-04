import { describe, expect, it } from 'vitest';
import { appendRevision, createProjectDocument } from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  chooseProjectDocument,
  projectPreservesLocalWork,
  projectWorkDifferences
} from './localProjectStore';

const owner = toUserId('user_schema_comparison');

function project(): ProjectDocument {
  const base = createProjectDocument('Peachy Turtle', owner);
  return appendRevision({ ...base, version: 6 }, 'Renamed');
}

/** The same content as last written by the build before the schema bump. */
function savedByPreviousBuild(document: ProjectDocument): ProjectDocument {
  return {
    ...structuredClone(document),
    schemaVersion: (PROJECT_DOCUMENT_SCHEMA_VERSION -
      1) as ProjectDocument['schemaVersion']
  };
}

describe('comparing copies across a schema bump', () => {
  // Regression: after the v53 -> v54 bump every unchanged cloud project
  // opened with both a room and an account conflict whose two rows matched in
  // every shown detail, because only some load paths normalize.
  it('treats an un-normalized local copy as the account copy it matches', () => {
    const account = project();
    const local = savedByPreviousBuild(account);
    expect(projectPreservesLocalWork(local, account)).toBe(true);
    expect(chooseProjectDocument(local, account, account.version).choice).toBe(
      'remote'
    );
    expect(chooseProjectDocument(local, account).choice).toBe('remote');
  });

  it('treats a raw room frame as the hydrated document it matches', () => {
    const hydrated = project();
    const room = savedByPreviousBuild(hydrated);
    expect(projectPreservesLocalWork(hydrated, room)).toBe(true);
    expect(projectWorkDifferences(hydrated, room)).toEqual([]);
  });

  it('still reports real divergence behind an older schema stamp', () => {
    const account = project();
    const local = savedByPreviousBuild({ ...account, name: 'Edited here' });
    expect(projectPreservesLocalWork(local, account)).toBe(false);
    expect(chooseProjectDocument(local, account, account.version).choice).toBe(
      'diverged'
    );
    expect(projectWorkDifferences(local, account)).toEqual(['name']);
  });
});

describe('projectWorkDifferences', () => {
  it('names each differing part in a stable order', () => {
    const remote = project();
    const local = {
      ...appendRevision(structuredClone(remote), 'Edit'),
      units: remote.units === 'mm' ? ('inch' as const) : ('mm' as const),
      name: 'Other'
    };
    expect(projectWorkDifferences(local, remote)).toEqual([
      'name',
      'units',
      'edits'
    ]);
  });

  it('is empty for identical copies', () => {
    const document = project();
    expect(projectWorkDifferences(document, structuredClone(document))).toEqual(
      []
    );
  });
});
