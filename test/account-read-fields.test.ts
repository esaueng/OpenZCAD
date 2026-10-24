import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { importArtifactIds } from '@openzcad/persistence';
import {
  accountReadFieldsError,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

// ADR-024 Phase 1: the account stores documents without normalizing them, so
// the few parts it reads itself are checked at the boundary, and the helpers
// that walk stored documents skip what they cannot read instead of throwing.
describe('fields the account reads from stored documents', () => {
  const base = createProjectDocument('Readable', toUserId('owner'));

  it('accepts what browsers send', () => {
    expect(accountReadFieldsError(base)).toBeNull();
  });

  it.each([
    ['derived', undefined],
    ['derived', { warnings: 'none', updatedAt: '2026-10-24T00:00:00Z' }],
    ['assets', undefined],
    ['assets', { a: 'not an asset' }],
    ['assets', { a: { artifactId: 7 } }],
    ['referenceImages', { images: 5 }],
    ['referenceImages', { images: ['not an image'] }]
  ] as const)('refuses an unreadable %s', (field, value) => {
    const document: Record<string, unknown> = { ...base };
    if (value === undefined) delete document[field];
    else document[field] = value;
    expect(accountReadFieldsError(document)).toMatch(/^Project document /);
  });

  it('walks a stored document without assets or readable images', () => {
    const stored = {
      ...base,
      assets: undefined,
      referenceImages: { images: 5 }
    } as unknown as ProjectDocument;
    expect(importArtifactIds(stored)).toEqual([]);
  });
});
