// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  handleGlimpseUsage,
  parseUsage,
  countApi,
  type GlimpseEnv
} from './glimpse';
const valid = { event: 'export_completed', bucket: 'none' };
function request(body: unknown = valid, headers: Record<string, string> = {}) {
  return new Request('https://app.test/api/glimpse/usage', {
    method: 'POST',
    headers: {
      Origin: 'https://app.test',
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
}
function setup() {
  const record = vi.fn().mockResolvedValue(undefined);
  const env: GlimpseEnv = {
    GLIMPSE: { record },
    GLIMPSE_BASIC_ENABLED: 'true',
    GLIMPSE_USAGE_ENABLED: 'true',
    GLIMPSE_USAGE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true })
    }
  };
  return { record, env };
}
describe('Glimpse privacy boundary', () => {
  it('rejects every identifying or caller-controlled extra field', () => {
    for (const key of [
      'filename',
      'geometry',
      'email',
      'projectName',
      'url',
      'app',
      'level',
      'timestamp',
      'count'
    ])
      expect(parseUsage({ ...valid, [key]: 'secret' })).toBeNull();
    expect(parseUsage({ ...valid, event: 'private.step' })).toBeNull();
  });
  it('accepts only same-origin POSTs with bounded JSON and strips transport metadata', async () => {
    const { record, env } = setup();
    expect(
      (
        await handleGlimpseUsage(
          request(valid, {
            Cookie: 'session=private',
            'CF-Connecting-IP': '192.0.2.1'
          }),
          env
        )
      ).status
    ).toBe(204);
    expect(record).toHaveBeenCalledExactlyOnceWith({
      level: 'optional',
      ...valid
    });
    for (const req of [
      request(valid, { Origin: 'https://other.test' }),
      request(valid, { 'Content-Type': 'text/plain' }),
      request({ ...valid, email: 'secret' }),
      request({ event: 'x'.repeat(300), bucket: 'none' })
    ])
      expect(
        (await handleGlimpseUsage(req, env)).status
      ).toBeGreaterThanOrEqual(400);
    expect(record).toHaveBeenCalledOnce();
  });
  it('enforces the real byte bound without trusting Content-Length', async () => {
    const { record, env } = setup();
    const encoder = new TextEncoder();
    const req = new Request('https://app.test/api/glimpse/usage', {
      method: 'POST',
      headers: {
        Origin: 'https://app.test',
        'Content-Type': 'application/json'
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(' '.repeat(300)));
          c.close();
        }
      }),
      duplex: 'half'
    } as RequestInit);
    expect((await handleGlimpseUsage(req, env)).status).toBe(413);
    expect(record).not.toHaveBeenCalled();
  });
  it('limits anonymous ingress using a constant app-scoped key', async () => {
    const { record, env } = setup();
    env.GLIMPSE_USAGE_LIMITER = {
      limit: vi.fn().mockResolvedValue({ success: false })
    };
    expect((await handleGlimpseUsage(request(), env)).status).toBe(429);
    expect(record).not.toHaveBeenCalled();
  });
  it('has deployment kill switches and no required analytics dependency', async () => {
    const { record, env } = setup();
    env.GLIMPSE_USAGE_ENABLED = 'false';
    env.GLIMPSE_BASIC_ENABLED = 'false';
    await handleGlimpseUsage(request(), env);
    await countApi(env, 500, 1400);
    expect(record).not.toHaveBeenCalled();
    await expect(countApi({}, 500, 1)).resolves.toBeUndefined();
  });
  it('records only fixed backend counters and coarse latency; collector failures never affect operations', async () => {
    const { record, env } = setup();
    await countApi(env, 503, 1500);
    expect(record.mock.calls.map((c) => c[0] as unknown)).toEqual([
      { level: 'basic', event: 'api_request', bucket: 'none' },
      { level: 'basic', event: 'api_latency', bucket: '1s_10s' },
      { level: 'basic', event: 'api_error', bucket: 'none' }
    ]);
    record.mockRejectedValue(new Error('unavailable'));
    await expect(countApi(env, 200, 10)).resolves.toBeUndefined();
  });
});
