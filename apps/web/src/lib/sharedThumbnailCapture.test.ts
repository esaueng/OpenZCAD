import { expect, it, vi } from 'vitest';
import { toProjectId } from '@openzcad/shared';
import { sharedThumbnailCapture } from './sharedThumbnailCapture';

const resident = vi.hoisted(() => ({
  activity: vi.fn(),
  setBusy: vi.fn(),
  stage: vi.fn(),
  flush: vi.fn(async () => undefined),
  discard: vi.fn(),
  subscribe: vi.fn(() => vi.fn())
}));

vi.mock('./projectThumbnailCapture', () => ({
  createThumbnailCapture: () => resident
}));

it('stages and starts a leave-time flush without waiting for a module load', async () => {
  const entry = {
    projectId: toProjectId('resident_card'),
    version: 1,
    updatedAt: '2026-10-08',
    bodies: []
  };
  const host = {
    render: () => null,
    save: async () => undefined,
    load: async () => null,
    queue: async <T>(work: () => T) => work()
  };
  sharedThumbnailCapture.stage(entry, host);
  const flushed = sharedThumbnailCapture.flush();
  // Pagehide does not await promises. The resident coordinator must receive
  // both operations before any task or import continuation can be cancelled.
  expect(resident.stage).toHaveBeenCalledWith(entry, host);
  expect(resident.flush).toHaveBeenCalledOnce();
  await flushed;
  sharedThumbnailCapture.discard();
});
