import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_URL_LIFETIME_MS, downloadBlob } from './saveFile';
import { downloadText } from './model';
import { downloadBackupFile } from './projectBackupTransfer';

describe('downloadBlob', () => {
  let revoke: ReturnType<typeof vi.fn<(url: string) => void>>;
  let clicks: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    clicks = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:openzcad/1');
    revoke = vi.fn<(url: string) => void>();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push(`${this.download}@${this.href}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['downloadBlob', () => downloadBlob('part.step', new Blob(['x']))],
    ['downloadText', () => downloadText('part.step', 'x')],
    [
      'downloadBackupFile',
      () => downloadBackupFile('part.step', new Blob(['x']))
    ]
  ])('%s keeps the blob URL alive until WebKit has read it', (_name, save) => {
    save();
    expect(clicks).toEqual(['part.step@blob:openzcad/1']);
    // Revoked at click time, Safari could cancel the save it just began.
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOWNLOAD_URL_LIFETIME_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:openzcad/1');
  });
});
