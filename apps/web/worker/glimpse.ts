// Deliberately duplicated small wire contract; Glimpse revalidates at its RPC boundary.
export interface GlimpseBinding {
  record(value: {
    level: 'basic' | 'optional';
    event: string;
    bucket: string;
  }): Promise<void>;
}
export interface GlimpseEnv {
  GLIMPSE?: unknown;
  GLIMPSE_USAGE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  GLIMPSE_BASIC_ENABLED?: string;
  GLIMPSE_USAGE_ENABLED?: string;
}
function glimpseBinding(value: unknown): GlimpseBinding | undefined {
  // Cross-repository RPC is not resolvable by Wrangler before first deployment.
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined;
  const candidate = value as Partial<GlimpseBinding>;
  return typeof candidate.record === 'function'
    ? (candidate as GlimpseBinding)
    : undefined;
}
const EVENTS = new Set([
  'workspace_opened',
  'export_completed',
  'export_failed',
  'workflow_model',
  'workflow_setup',
  'feature_used',
  'operation_latency'
]);
const BUCKETS = new Set([
  'lt_100ms',
  '100ms_1s',
  '1s_10s',
  '10s_60s',
  'gte_60s'
]);
export function parseUsage(
  value: unknown
): { level: 'optional'; event: string; bucket: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 2 ||
    typeof v.event !== 'string' ||
    typeof v.bucket !== 'string' ||
    !EVENTS.has(v.event)
  )
    return null;
  if (
    v.event === 'operation_latency'
      ? !BUCKETS.has(v.bucket)
      : v.bucket !== 'none'
  )
    return null;
  return { level: 'optional', event: v.event, bucket: v.bucket };
}
export async function handleGlimpseUsage(
  request: Request,
  env: GlimpseEnv
): Promise<Response> {
  const reply = (status: number) =>
    new Response(null, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  if (request.method !== 'POST') return reply(405);
  if (
    request.headers.get('Origin') !== new URL(request.url).origin ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    return reply(403);
  const collector = glimpseBinding(env.GLIMPSE);
  if (!collector || env.GLIMPSE_USAGE_ENABLED !== 'true') return reply(204);
  if (
    !env.GLIMPSE_USAGE_LIMITER ||
    !(await env.GLIMPSE_USAGE_LIMITER.limit({ key: 'aggregate-usage' })).success
  )
    return reply(429);
  if (request.headers.get('Content-Type') !== 'application/json')
    return reply(415);
  if (Number(request.headers.get('Content-Length')) > 256) return reply(413);
  const reader = request.body?.getReader();
  if (!reader) return reply(400);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 256) {
        await reader.cancel();
        return reply(413);
      }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const value = parseUsage(JSON.parse(new TextDecoder().decode(bytes)));
    if (!value) return reply(400);
    // Constructed RPC contains no client headers, app override, URL, or identity.
    await collector.record(value);
    return reply(204);
  } catch {
    return reply(400);
  }
}
export async function countApi(
  env: GlimpseEnv,
  status: number,
  elapsedMs: number
): Promise<void> {
  const collector = glimpseBinding(env.GLIMPSE);
  if (!collector || env.GLIMPSE_BASIC_ENABLED !== 'true') return;
  const bucket =
    elapsedMs < 100
      ? 'lt_100ms'
      : elapsedMs < 1000
        ? '100ms_1s'
        : elapsedMs < 10000
          ? '1s_10s'
          : elapsedMs < 60000
            ? '10s_60s'
            : 'gte_60s';
  try {
    await collector.record({
      level: 'basic',
      event: 'api_request',
      bucket: 'none'
    });
    await collector.record({ level: 'basic', event: 'api_latency', bucket });
    if (status >= 500)
      await collector.record({
        level: 'basic',
        event: 'api_error',
        bucket: 'none'
      });
  } catch {
    /* Metrics must never fail an app operation. No payload logging. */
  }
}
