/**
 * Answers the requests no static asset matched. The asset layer used to do
 * this itself (`not_found_handling: "single-page-application"`), which served
 * the app shell for every miss — `/assets/*` included. A tab left open across
 * a deploy then got HTML for a chunk the new deploy had renamed, and `_headers`
 * stamped that HTML `immutable` for a year under the chunk's URL, so the
 * browser kept failing the import even after a reload.
 *
 * A fingerprinted path that does not exist is now a 404 nothing may cache;
 * any other GET or HEAD still opens the app shell.
 */
export const HASHED_ASSET_PATH = /^\/assets\//;

const NO_STORE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin'
};

export function missingAssetResponse(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      ...NO_STORE_HEADERS,
      'content-type': 'text/plain; charset=utf-8'
    }
  });
}

/** Null for the Worker's own routes, which handle their own misses. */
export async function serveAssetFallback(
  request: Request,
  // Read only for a miss: liveness and the API never touch the binding.
  assets: () => { fetch(request: Request): Promise<Response> } | undefined
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
    return null;
  }
  if (HASHED_ASSET_PATH.test(url.pathname)) return missingAssetResponse();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, {
      status: 405,
      headers: { ...NO_STORE_HEADERS, allow: 'GET, HEAD' }
    });
  }
  const binding = assets();
  if (!binding) {
    return new Response('Asset service unavailable.', {
      status: 503,
      headers: NO_STORE_HEADERS
    });
  }
  // The shell, with the `_headers` policy the asset layer applies to `/`.
  return binding.fetch(
    new Request(new URL('/', url), {
      method: request.method,
      headers: request.headers
    })
  );
}
