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

it('accepts bounded expanded diagnostics and rejects private text and extra dimensions', () => {
  expect(parseUsage({event:'project_size',bucket:'1_10mib'})).toEqual({level:'optional',event:'project_size',bucket:'1_10mib'});
  expect(parseUsage({event:'error_runtime',bucket:'none'})).toEqual({level:'optional',event:'error_runtime',bucket:'none'});
  expect(parseUsage({event:'error_runtime',bucket:'private.step'})).toBeNull();
  expect(parseUsage({event:'error_runtime',bucket:'none',stack:'private'})).toBeNull();
});

it('keeps client and relay wire vocabularies aligned', async () => {
  const client=await import('../src/lib/glimpseContract');
  const relay=await import('./glimpseContract');
  expect(client.EXPANDED).toEqual(relay.EXPANDED);
  expect(client.CENSUS_FIELDS).toEqual(relay.CENSUS_FIELDS);
  expect(client.ACTIVITY_FIELDS).toEqual(relay.ACTIVITY_FIELDS);
  expect(client.ACCOUNT_STATISTICS_VERSION).toBe(
    relay.ACCOUNT_STATISTICS_VERSION
  );
});

// Glimpse privacy review approved 13 Nov 2026 (esaueng/glimpse#32).
it.each([
  'error_unresponsive',
  'error_gpu_lost',
  'error_out_of_memory',
  'error_worker'
])('relays the new diagnostic code %s with only the bucket none', (event) => {
  expect(parseUsage({ event, bucket: 'none' })).toEqual({
    level: 'optional',
    event,
    bucket: 'none'
  });
  expect(parseUsage({ event, bucket: '5123ms' })).toBeNull();
  expect(parseUsage({ event, bucket: 'none', adapter: 'Private GPU' })).toBeNull();
});

it('accepts activity counts only all together, bounded and consistent', async () => {
  const { census } = await import('./glimpseContract');
  const base = {
    generation: 3,
    accounts: 20,
    projects: 1,
    revisions: 0,
    storedBytes: 1,
    logicalBytes: 1,
    unknownArtifacts: 0,
    lt1mib: 1,
    mib1to10: 0,
    mib10to100: 0,
    gte100mib: 0
  };
  expect(census(base, 'openzcad')).toEqual(base);
  const full = { ...base, active7d: 5, active30d: 10, idle90d: 10 };
  expect(census(full, 'openzcad')).toEqual(full);
  const withheld = { ...base, active7d: null, active30d: null, idle90d: null };
  expect(census(withheld, 'openzcad')).toEqual(withheld);
  for (const invalid of [
    { ...base, active7d: 5 },
    { ...base, active7d: 5, active30d: 10 },
    { ...full, active7d: 11 },
    { ...full, idle90d: 11 },
    { ...full, active30d: 21 },
    { ...full, idle90d: -1 },
    { ...full, idle90d: 1.5 },
    { ...full, idle90d: '5' },
    { ...full, lastSave: '2026-11-13' }
  ])
    expect(census(invalid, 'openzcad'), JSON.stringify(invalid)).toBeNull();
});

it('relays only canonical kernel_refused buckets and nothing beside them', async () => {
  const bucket =
    'direct-edit.resize-cylindrical-face|direct-edit|resize-cylindrical-face|unsupported|unsupported_move_face|build-failed|cylinder|plane+sphere';
  expect(parseUsage({ event: 'kernel_refused', bucket })).toEqual({
    level: 'optional',
    event: 'kernel_refused',
    bucket
  });
  for (const rejected of [
    { event: 'kernel_refused', bucket: 'none' },
    {
      event: 'kernel_refused',
      bucket: bucket.replace('cylinder|', 'Acme part|')
    },
    {
      event: 'kernel_refused',
      bucket: bucket.replace('unsupported_move_face|', 'feat_0b1c|')
    },
    { event: 'kernel_refused', bucket, featureName: 'Acme' },
    { event: 'kernel_refused', bucket, geometry: { radius: 6 } }
  ]) {
    expect(parseUsage(rejected), JSON.stringify(rejected)).toBeNull();
  }
  const client = await import('../src/lib/glimpseContract');
  const relay = await import('./glimpseContract');
  for (const operation of client.REFUSAL_DIRECT_EDIT_OPERATIONS) {
    const direct = `direct-edit.${operation}|direct-edit|${operation}|unsupported|unsupported_move_face|build-failed|cylinder|sphere`;
    expect(
      parseUsage({ event: 'kernel_refused', bucket: direct })
    ).not.toBeNull();
    expect(relay.parseKernelRefusedBucket(direct)).toEqual(
      client.parseKernelRefusedBucket(direct)
    );
  }
  for (const candidate of [
    bucket,
    'boolean|boolean|cut|internal|operation_failed|build-failed|none|none',
    'boolean|boolean|cut|internal|body_abcd|build-failed|none|none',
    'boolean|boolean|cut|internal|operation_failed|build-failed|none|sphere+plane'
  ]) {
    expect(relay.parseKernelRefusedBucket(candidate)).toEqual(
      client.parseKernelRefusedBucket(candidate)
    );
  }
});
