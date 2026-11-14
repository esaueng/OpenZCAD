import { SHARE_LINK_TOKEN_HEADER, shareLinkTokenPath } from '@openzcad/shared';

/**
 * A token segment no share link can have, so a token-free share request
 * without a usable token reaches the share handlers' own opaque 404.
 */
const UNUSABLE_TOKEN = '!';

/**
 * The path the share handlers should see for this request. A share-link
 * read may send its capability in `SHARE_LINK_TOKEN_HEADER` to a token-free
 * route (see packages/shared/src/share-link-token.ts), which keeps the token
 * out of the URL that Cloudflare's request logs record; it is mapped onto
 * the path form the handlers parse, so both forms are served by one code
 * path. The path forms stay served: the macOS host forwards no request
 * headers yet, and a tab opened before a deploy still uses them. Any other
 * request's path is returned unchanged.
 */
export function shareCapabilityPathname(
  request: Request,
  pathname: string
): string {
  if (request.method !== 'GET') return pathname;
  const token = request.headers.get(SHARE_LINK_TOKEN_HEADER) ?? '';
  return (
    shareLinkTokenPath(
      pathname,
      /^[A-Za-z0-9_-]{1,256}$/.test(token) ? token : UNUSABLE_TOKEN
    ) ?? pathname
  );
}
