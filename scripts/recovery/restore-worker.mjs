/** Private, disposable restore ingress. Never deploy with production bindings. */
export default {
  async fetch(request, env) {
    if (
      !/^openzcad-recovery-drill-[a-z0-9-]+$/.test(env.TARGET_BUCKET ?? '') ||
      typeof env.RESTORE_TOKEN !== 'string' ||
      env.RESTORE_TOKEN.length < 43
    ) {
      return new Response(null, { status: 503 });
    }
    const supplied = request.headers.get('authorization') ?? '';
    const hash = async (text) =>
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      );
    const a = await hash(supplied),
      b = await hash('Bearer ' + env.RESTORE_TOKEN);
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    if (
      difference ||
      request.method !== 'PUT' ||
      new URL(request.url).pathname !== '/restore'
    ) {
      return new Response(null, { status: 404 });
    }
    const encoded = request.headers.get('x-openzcad-metadata');
    const length = Number(request.headers.get('content-length'));
    if (
      !encoded ||
      encoded.length > 32768 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 100 * 1024 ** 2
    ) {
      return new Response(null, { status: 400 });
    }
    let metadata;
    try {
      metadata = JSON.parse(decodeURIComponent(encoded));
      if (
        typeof metadata.key !== 'string' ||
        !metadata.key ||
        metadata.key.includes('\0') ||
        new TextEncoder().encode(metadata.key).length > 1024
      )
        throw new Error();
      if (metadata.size !== length) throw new Error();
      if (metadata.http_metadata?.cacheExpiry)
        metadata.http_metadata.cacheExpiry = new Date(
          metadata.http_metadata.cacheExpiry
        );
    } catch {
      return new Response(null, { status: 400 });
    }
    // If the target already contains an object, fail instead of overwriting a drill.
    const result = await env.TARGET.put(metadata.key, request.body, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: metadata.http_metadata ?? {},
      customMetadata: metadata.custom_metadata ?? {}
    });
    return new Response(null, { status: result ? 201 : 409 });
  }
};
