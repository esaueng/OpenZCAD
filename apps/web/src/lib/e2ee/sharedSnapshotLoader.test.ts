import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopFetch } from '../desktopBridge';
import { loadEncryptedSharedProject } from './sharedSnapshotLoader';
import { formatShareFragment, shareLinkToken } from './shareLinkFragment';

vi.mock('../desktopBridge', () => ({ desktopFetch: vi.fn() }));

describe('the encrypted share-link loader’s transport (#923 review)', () => {
  afterEach(() => {
    vi.mocked(desktopFetch).mockReset();
  });

  it('reads the snapshot through the desktop bridge by default', async () => {
    // The packaged app's WebView origin is not the API's: a plain fetch of
    // `/api/e2ee/share/…` would miss zcad.app.
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response(null, { status: 404 })
    );
    const shareKey = crypto.getRandomValues(new Uint8Array(32));
    const token = await shareLinkToken(shareKey);
    const link = formatShareFragment({
      token,
      shareKey,
      ownerIdentityHash: crypto.getRandomValues(new Uint8Array(32))
    }).slice('share='.length);

    expect(await loadEncryptedSharedProject(link)).toBeNull();
    expect(desktopFetch).toHaveBeenCalledWith(
      `/api/e2ee/share/${encodeURIComponent(token)}`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('still takes a transport a caller passes', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const shareKey = crypto.getRandomValues(new Uint8Array(32));
    const link = formatShareFragment({
      token: await shareLinkToken(shareKey),
      shareKey,
      ownerIdentityHash: crypto.getRandomValues(new Uint8Array(32))
    }).slice('share='.length);

    expect(
      await loadEncryptedSharedProject(link, () => true, {
        fetch: fetch as unknown as typeof globalThis.fetch
      })
    ).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(desktopFetch).not.toHaveBeenCalled();
  });
});
