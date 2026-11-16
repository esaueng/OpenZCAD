import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { useRefusalHarvest } from './useRefusalHarvest';

// The harvester's chunk cannot load (offline, or replaced by a deploy).
vi.mock('../lib/refusalHarvest', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

describe('refusal harvester chunk', () => {
  it('lets an edit check finish unobserved when the harvester cannot load', async () => {
    const document = createProjectDocument('Private', toUserId('local'));
    const rebuild = vi.fn(async () => document.derived);
    const { result } = renderHook(() =>
      useRefusalHarvest({
        document,
        currentDocument: () => document,
        warnings: [],
        rebuild,
        track: vi.fn()
      })
    );
    await expect(result.current.syncCandidate(document)).resolves.toBe(
      document.derived
    );
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(result.current.held).toBeNull();
  });
});
