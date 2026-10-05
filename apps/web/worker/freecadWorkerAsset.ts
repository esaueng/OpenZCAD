/** The pinned OCCT Embind runtime generates JS bindings in this worker only. */
export const FREECAD_WORKER_PATH = /^\/assets\/freecadImportWorker-[\w-]+\.js$/;
export const FREECAD_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export async function serveFreecadWorkerAsset(
  request: Request,
  assets: { fetch(request: Request): Promise<Response> }
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const asset = await assets.fetch(request);
  // A missing chunk can fall back to the SPA HTML. Never relax that policy.
  if (
    !asset.ok ||
    !/^(?:text|application)\/javascript\b/i.test(
      asset.headers.get('content-type') ?? ''
    )
  ) {
    return asset;
  }
  const response = new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers: asset.headers
  });
  response.headers.set('Content-Security-Policy', FREECAD_WORKER_CSP);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return response;
}
