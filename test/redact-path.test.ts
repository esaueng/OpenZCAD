import { describe, expect, it } from 'vitest';
import {
  REDACTED_PATH_SEGMENT,
  redactPath
} from '../apps/web/worker/redactPath';

const TOKEN = 'zs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('redactPath', () => {
  it.each([
    [`/api/share/${TOKEN}`, '/api/share/:redacted'],
    [
      `/api/share/${TOKEN}/assets/asset-1`,
      '/api/share/:redacted/assets/asset-1'
    ],
    [
      `/api/share/${TOKEN}/sources/source-1`,
      '/api/share/:redacted/sources/source-1'
    ],
    [`/api/e2ee/share/${TOKEN}`, '/api/e2ee/share/:redacted'],
    [
      `/api/e2ee/share/${TOKEN}/blobs/blob-1`,
      '/api/e2ee/share/:redacted/blobs/blob-1'
    ]
  ])('drops the capability token from %s', (pathname, expected) => {
    const redacted = redactPath(pathname);
    expect(redacted).toBe(expected);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain(REDACTED_PATH_SEGMENT);
  });

  it.each([
    '/api/projects/project-1',
    '/api/projects/project-1/share-links/link-1',
    '/api/e2ee/projects/project-1/share-links/link-1/snapshot',
    '/api/project-invitations/accept',
    '/api/share',
    '/api/sharex/token'
  ])('leaves %s, which carries no capability, unchanged', (pathname) => {
    expect(redactPath(pathname)).toBe(pathname);
  });
});
