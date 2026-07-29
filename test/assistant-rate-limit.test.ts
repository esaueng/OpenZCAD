import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import {
  acquireAssistantPermit,
  assistantQuotaCost
} from '../apps/web/worker/assistantRateLimit';

interface Lease {
  accountBucket: string;
  ipBucket: string;
  expiresAt: number;
}

function assistantGuardD1() {
  const usage = new Map<
    string,
    { windowStart: number; requestCount: number; costUnits: number }
  >();
  const leases = new Map<string, Lease>();

  function prepare(query: string): D1PreparedStatement {
    let values: unknown[] = [];
    const statement = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return statement;
      },
      async first<T>() {
        if (query.includes('FROM user_settings')) {
          return {
            settings_json: JSON.stringify({
              ...DEFAULT_APP_SETTINGS,
              assistant: {
                ...DEFAULT_APP_SETTINGS.assistant,
                enabled: true
              }
            }),
            revision: 1
          } as T;
        }
        if (query.includes('INSERT INTO ai_concurrency_leases')) {
          const [
            leaseId,
            accountBucket,
            ipBucket,
            expiresAt,
            ,
            nowSeconds,
            accountLimit,
            ,
            ,
            ipLimit
          ] = values;
          const active = [...leases.values()].filter(
            (lease) => lease.expiresAt > Number(nowSeconds)
          );
          if (
            active.filter(
              (lease) => lease.accountBucket === String(accountBucket)
            ).length >= Number(accountLimit) ||
            active.filter((lease) => lease.ipBucket === String(ipBucket))
              .length >= Number(ipLimit)
          ) {
            return null;
          }
          leases.set(String(leaseId), {
            accountBucket: String(accountBucket),
            ipBucket: String(ipBucket),
            expiresAt: Number(expiresAt)
          });
          return { lease_id: leaseId } as T;
        }
        if (query.includes('INSERT INTO ai_rate_limits')) {
          const bucket = String(values[0]);
          const windowStart = Number(values[1]);
          const cost = Number(values[2]);
          const previous = usage.get(bucket);
          const current =
            previous?.windowStart === windowStart
              ? {
                  windowStart,
                  requestCount: previous.requestCount + 1,
                  costUnits: previous.costUnits + cost
                }
              : { windowStart, requestCount: 1, costUnits: cost };
          usage.set(bucket, current);
          return {
            request_count: current.requestCount,
            cost_units: current.costUnits
          } as T;
        }
        return null;
      },
      async run() {
        if (
          query.includes('DELETE FROM ai_concurrency_leases') &&
          query.includes('expires_at')
        ) {
          const nowSeconds = Number(values[0]);
          for (const [leaseId, lease] of leases) {
            if (lease.expiresAt <= nowSeconds) {
              leases.delete(leaseId);
            }
          }
        } else if (
          query.includes('DELETE FROM ai_concurrency_leases WHERE lease_id = ?')
        ) {
          leases.delete(String(values[0]));
        }
        return { success: true, meta: { changes: 1 } };
      }
    };
    return statement as unknown as D1PreparedStatement;
  }

  return {
    db: { prepare } as unknown as D1Database,
    activeLeases: () => leases.size
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function assistantRequest(ip = '203.0.113.42'): Request {
  return new Request('https://example.com/api/assistant/proposals', {
    headers: { 'cf-connecting-ip': ip }
  });
}

describe('assistant provider usage guard', () => {
  it('weights the configured token ceiling and drawing inputs', () => {
    expect(assistantQuotaCost(0, 8_000)).toBe(1);
    expect(assistantQuotaCost(0, 32_000)).toBe(4);
    expect(assistantQuotaCost(2, 32_000)).toBe(8);
    expect(assistantQuotaCost(-1, Number.NaN)).toBe(1);
  });

  it('atomically caps account requests and token-weighted cost before dispatch', async () => {
    const fixture = assistantGuardD1();
    const base = {
      ENVIRONMENT: 'beta' as const,
      DB: fixture.db,
      AI_RATE_LIMIT_WINDOW_SECONDS: '60',
      AI_ACCOUNT_RATE_LIMIT_REQUESTS: '2',
      AI_IP_RATE_LIMIT_REQUESTS: '20',
      AI_ACCOUNT_COST_LIMIT_UNITS: '100',
      AI_IP_COST_LIMIT_UNITS: '100'
    };
    const userId = toUserId('user_rate_test');
    const options = { cost: 1, leaseMs: 30_000, now: 1_000 };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const permit = await acquireAssistantPermit(
        assistantRequest(),
        userId,
        base,
        options
      );
      expect(permit.allowed).toBe(true);
      if (permit.allowed) {
        await permit.release();
      }
    }
    const limited = await acquireAssistantPermit(
      assistantRequest(),
      userId,
      base,
      options
    );
    expect(limited.allowed).toBe(false);
    if (!limited.allowed) {
      expect(limited.response.status).toBe(429);
      await expect(limited.response.json()).resolves.toMatchObject({
        code: 'AI_RATE_LIMITED'
      });
    }

    const costEnv = {
      ...base,
      AI_ACCOUNT_RATE_LIMIT_REQUESTS: '20',
      AI_ACCOUNT_COST_LIMIT_UNITS: '5'
    };
    const costUserId = toUserId('user_cost_test');
    const first = await acquireAssistantPermit(
      assistantRequest('203.0.113.43'),
      costUserId,
      costEnv,
      { ...options, cost: 4 }
    );
    expect(first.allowed).toBe(true);
    if (first.allowed) {
      await first.release();
    }
    const overCost = await acquireAssistantPermit(
      assistantRequest('203.0.113.43'),
      costUserId,
      costEnv,
      { ...options, cost: 2 }
    );
    expect(overCost.allowed).toBe(false);
    if (!overCost.allowed) {
      await expect(overCost.response.json()).resolves.toMatchObject({
        code: 'AI_RATE_LIMITED'
      });
    }
  });

  it('blocks repeated proposal-route dispatches after the configured limit', async () => {
    const fixture = assistantGuardD1();
    const providerFetch = vi.fn(
      async () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    );
    vi.stubGlobal('fetch', providerFetch);
    const env = {
      ENVIRONMENT: 'beta' as const,
      AUTH_MODE: 'email-code' as const,
      DB: fixture.db,
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://models.example.test/v1/responses',
      AI_ACCOUNT_RATE_LIMIT_REQUESTS: '2',
      AI_IP_RATE_LIMIT_REQUESTS: '2',
      AI_ACCOUNT_COST_LIMIT_UNITS: '100',
      AI_IP_COST_LIMIT_UNITS: '100'
    };
    const request = () =>
      new Request('https://example.com/api/assistant/proposals', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.44' },
        body: JSON.stringify({
          prompt: 'Make it wider',
          digest: {
            schemaVersion: 3,
            projectId: 'proj_ai_limited',
            name: 'Bracket',
            units: 'mm',
            version: 1,
            parameters: [],
            features: [],
            warnings: []
          }
        })
      });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await worker.fetch(request(), env);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    const limited = await worker.fetch(request(), env);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      code: 'AI_RATE_LIMITED'
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('limits concurrent work by account and opaque IP, then releases on cancellation', async () => {
    const fixture = assistantGuardD1();
    const env = {
      ENVIRONMENT: 'beta' as const,
      DB: fixture.db,
      AI_ACCOUNT_CONCURRENCY_LIMIT: '1',
      AI_IP_CONCURRENCY_LIMIT: '1',
      AI_ACCOUNT_RATE_LIMIT_REQUESTS: '20',
      AI_IP_RATE_LIMIT_REQUESTS: '20',
      AI_ACCOUNT_COST_LIMIT_UNITS: '100',
      AI_IP_COST_LIMIT_UNITS: '100'
    };
    const options = { cost: 1, leaseMs: 30_000, now: 1_000 };
    const firstUser = toUserId('user_concurrency_a');
    const secondUser = toUserId('user_concurrency_b');

    const [first, sameAccount] = await Promise.all([
      acquireAssistantPermit(assistantRequest(), firstUser, env, options),
      acquireAssistantPermit(assistantRequest(), firstUser, env, options)
    ]);
    expect([first.allowed, sameAccount.allowed].sort()).toEqual([false, true]);
    const active = first.allowed ? first : sameAccount;
    const rejected = first.allowed ? sameAccount : first;
    if (!rejected.allowed) {
      await expect(rejected.response.json()).resolves.toMatchObject({
        code: 'AI_CONCURRENCY_LIMITED'
      });
    }

    const sameIp = await acquireAssistantPermit(
      assistantRequest(),
      secondUser,
      env,
      options
    );
    expect(sameIp.allowed).toBe(false);

    if (active.allowed) {
      const response = active.track(
        new Response(
          new ReadableStream({
            cancel() {}
          }),
          {
            headers: { 'content-type': 'text/event-stream' }
          }
        )
      );
      await response.body?.cancel();
    }
    expect(fixture.activeLeases()).toBe(0);

    const afterCancel = await acquireAssistantPermit(
      assistantRequest(),
      secondUser,
      env,
      options
    );
    expect(afterCancel.allowed).toBe(true);
    if (afterCancel.allowed) {
      await afterCancel.release();
    }
  });

  it('fails closed in beta without both D1 and a connecting IP, while preserving local development', async () => {
    const userId = toUserId('user_guard_availability');
    const unavailable = await acquireAssistantPermit(
      assistantRequest(),
      userId,
      { ENVIRONMENT: 'beta' },
      { cost: 1, leaseMs: 30_000 }
    );
    expect(unavailable.allowed).toBe(false);
    if (!unavailable.allowed) {
      expect(unavailable.response.status).toBe(503);
      await expect(unavailable.response.json()).resolves.toMatchObject({
        code: 'AI_GUARD_UNAVAILABLE'
      });
    }

    const fixture = assistantGuardD1();
    const noIp = await acquireAssistantPermit(
      new Request('https://example.com/api/assistant/proposals'),
      userId,
      { ENVIRONMENT: 'beta', DB: fixture.db },
      { cost: 1, leaseMs: 30_000 }
    );
    expect(noIp.allowed).toBe(false);

    const local = await acquireAssistantPermit(
      new Request('https://example.com/api/assistant/proposals'),
      userId,
      { ENVIRONMENT: 'development' },
      { cost: 1, leaseMs: 30_000 }
    );
    expect(local.allowed).toBe(true);
  });
});
