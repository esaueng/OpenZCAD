import { describe, expect, it } from 'vitest';
import { sharedProjectSnapshotDocument as fromCore } from '@openzcad/document-core';
import { sharedProjectSnapshotDocument as fromPersistence } from '@openzcad/persistence';

describe('sharedProjectSnapshotDocument move (ADR-024 slice 5-9)', () => {
  it('is one function, exported from document-core and still from persistence', () => {
    expect(fromPersistence).toBe(fromCore);
  });
});
