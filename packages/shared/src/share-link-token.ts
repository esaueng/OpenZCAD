/**
 * Anonymous share-link reads carry their capability token in this request
 * header, to a route without it, rather than in the URL path: request logs
 * record a request's URL, and a token there is enough to open the link.
 *
 *   GET /api/share                    (the shared project)
 *   GET /api/share/assets/:assetId
 *   GET /api/share/sources/:sourceId
 *   GET /api/e2ee/share               (an encrypted link's snapshot)
 *   GET /api/e2ee/share/blobs/:blobId
 *
 * Each is served exactly as the path form that names the token,
 * `/api/share/:token…` and `/api/e2ee/share/:token…`, which the Worker
 * still serves for clients that cannot send the header.
 */
export const SHARE_LINK_TOKEN_HEADER = 'x-openzcad-share-token';

const TOKEN_FREE_SHARE_ROUTES: readonly [RegExp, string][] = [
  [/^\/api\/share()$/, '/api/share/'],
  [/^\/api\/share(\/(?:assets|sources)\/[^/]+)$/, '/api/share/'],
  [/^\/api\/e2ee\/share()$/, '/api/e2ee/share/'],
  [/^\/api\/e2ee\/share(\/blobs\/[^/]+)$/, '/api/e2ee/share/']
];

/**
 * The path form of a token-free share route (`pathname` without query),
 * with `tokenSegment` placed where the token goes; null for any other path.
 * `tokenSegment` must already be a single safe path segment.
 */
export function shareLinkTokenPath(
  pathname: string,
  tokenSegment: string
): string | null {
  for (const [route, prefix] of TOKEN_FREE_SHARE_ROUTES) {
    const match = route.exec(pathname);
    if (match) return `${prefix}${tokenSegment}${match[1] ?? ''}`;
  }
  return null;
}
