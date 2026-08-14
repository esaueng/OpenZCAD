import { describe, expect, it, vi } from 'vitest';
import {
  discardSharedPdfWorker,
  sharedPdfWorkerPort
} from '../apps/web/src/lib/assistant/attachments';

describe('shared PDF attachment worker recovery', () => {
  it('terminates and replaces a worker after a PDF failure', async () => {
    const first = { terminate: vi.fn() } as unknown as Worker;
    const second = { terminate: vi.fn() } as unknown as Worker;
    const factory = vi
      .fn<() => Promise<Worker>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    expect(await sharedPdfWorkerPort(factory)).toBe(first);
    expect(await sharedPdfWorkerPort(factory)).toBe(first);
    await discardSharedPdfWorker();
    expect(first.terminate).toHaveBeenCalledTimes(1);

    expect(await sharedPdfWorkerPort(factory)).toBe(second);
    await discardSharedPdfWorker();
    expect(second.terminate).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
