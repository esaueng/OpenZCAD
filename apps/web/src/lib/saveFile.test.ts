import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_URL_LIFETIME_MS, downloadBlob, saveFile } from './saveFile';
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

describe('saveFile', () => {
  function touchWindow({
    coarse = true,
    canShare = true,
    share = vi.fn(async () => undefined)
  }: {
    coarse?: boolean;
    canShare?: boolean;
    share?: (data: ShareData) => Promise<void>;
  } = {}) {
    return {
      win: {
        matchMedia: (query: string) => ({
          matches: coarse && query === '(pointer: coarse)'
        }),
        navigator: { share, canShare: () => canShare }
      } as unknown as Window,
      share
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:openzcad/2');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('offers a touch screen the share sheet with the file', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { win, share } = touchWindow();
    expect(await saveFile('bracket.step', new Blob(['x']), win)).toBe('shared');
    expect(share).toHaveBeenCalledOnce();
    const files = vi.mocked(share).mock.calls[0]![0].files!;
    expect(files[0]!.name).toBe('bracket.step');
    expect(click).not.toHaveBeenCalled();
  });

  it('saves nothing when the sheet is dismissed, and downloads when it is refused', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    const dismissed = touchWindow({ share: async () => Promise.reject(abort) });
    expect(await saveFile('a.step', new Blob(['x']), dismissed.win)).toBe(
      'cancelled'
    );
    expect(click).not.toHaveBeenCalled();
    const refused = Object.assign(new Error('no gesture'), {
      name: 'NotAllowedError'
    });
    const late = touchWindow({ share: async () => Promise.reject(refused) });
    expect(await saveFile('a.step', new Blob(['x']), late.win)).toBe(
      'downloaded'
    );
    expect(click).toHaveBeenCalledOnce();
  });

  it('downloads on a mouse, or where files cannot be shared', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const mouse = touchWindow({ coarse: false });
    expect(await saveFile('a.step', new Blob(['x']), mouse.win)).toBe(
      'downloaded'
    );
    const noFiles = touchWindow({ canShare: false });
    expect(await saveFile('a.step', new Blob(['x']), noFiles.win)).toBe(
      'downloaded'
    );
    expect(mouse.share).not.toHaveBeenCalled();
    expect(noFiles.share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(2);
  });
});
