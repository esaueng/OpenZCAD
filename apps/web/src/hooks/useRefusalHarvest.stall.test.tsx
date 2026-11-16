import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { HARVESTER_WAIT_MS, useRefusalHarvest } from './useRefusalHarvest';

// The harvester's chunk request stalls: it neither arrives nor fails.
vi.mock('../lib/refusalHarvest', () => new Promise(() => {}));

describe('refusal harvester chunk that stalls', () => {
  it('holds one edit check for at most the wait, then stops waiting for it', async () => {
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
    let started = performance.now();
    await expect(result.current.syncCandidate(document)).resolves.toBe(
      document.derived
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      HARVESTER_WAIT_MS - 50
    );
    started = performance.now();
    await expect(
      result.current.syncParameterCandidate('height', document)
    ).resolves.toBe(document.derived);
    expect(performance.now() - started).toBeLessThan(HARVESTER_WAIT_MS / 2);
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(result.current.held).toBeNull();
  });
});
