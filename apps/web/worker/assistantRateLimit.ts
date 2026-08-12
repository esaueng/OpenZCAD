import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import type { UserId } from '@openzcad/shared';

const DEFAULT_ACCOUNT_REQUEST_LIMIT = 6;
const DEFAULT_IP_REQUEST_LIMIT = 30;
const DEFAULT_ACCOUNT_COST_LIMIT = 24;
const DEFAULT_IP_COST_LIMIT = 120;
const DEFAULT_GLOBAL_DAILY_REQUEST_LIMIT = 100;
const DEFAULT_GLOBAL_DAILY_COST_LIMIT = 400;
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const DEFAULT_ACCOUNT_CONCURRENCY_LIMIT = 2;
const DEFAULT_IP_CONCURRENCY_LIMIT = 8;
const MAX_REQUEST_LIMIT = 1_000;
const MAX_COST_LIMIT = 10_000;
const MAX_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_CONCURRENCY_LIMIT = 100;
const OUTPUT_TOKEN_COST_UNIT = 8_000;
const ATTACHMENT_COST_UNITS = 2;
const LEASE_GRACE_SECONDS = 30;

interface UsageRow {
  request_count: number;
  cost_units: number;
}

interface AssistantGuardSettings {
  globalDailyRequestLimit: number;
  globalDailyCostLimit: number;
  accountRequestLimit: number;
  ipRequestLimit: number;
  accountCostLimit: number;
  ipCostLimit: number;
  windowSeconds: number;
  accountConcurrencyLimit: number;
  ipConcurrencyLimit: number;
}

export interface AssistantPermit {
  allowed: true;
  release(): Promise<void>;
  track(response: Response): Response;
}

export interface AssistantPermitDenied {
  allowed: false;
  response: Response;
}

export type AssistantPermitResult = AssistantPermit | AssistantPermitDenied;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = Number.parseInt(value?.trim() ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function guardSettings(env: CloudflareEnv): AssistantGuardSettings {
  return {
    globalDailyRequestLimit: boundedInteger(
      env.AI_GLOBAL_DAILY_REQUEST_LIMIT,
      DEFAULT_GLOBAL_DAILY_REQUEST_LIMIT,
      MAX_REQUEST_LIMIT
    ),
    globalDailyCostLimit: boundedInteger(
      env.AI_GLOBAL_DAILY_COST_LIMIT_UNITS,
      DEFAULT_GLOBAL_DAILY_COST_LIMIT,
      MAX_COST_LIMIT
    ),
    accountRequestLimit: boundedInteger(
      env.AI_ACCOUNT_RATE_LIMIT_REQUESTS,
      DEFAULT_ACCOUNT_REQUEST_LIMIT,
      MAX_REQUEST_LIMIT
    ),
    ipRequestLimit: boundedInteger(
      env.AI_IP_RATE_LIMIT_REQUESTS,
      DEFAULT_IP_REQUEST_LIMIT,
      MAX_REQUEST_LIMIT
    ),
    accountCostLimit: boundedInteger(
      env.AI_ACCOUNT_COST_LIMIT_UNITS,
      DEFAULT_ACCOUNT_COST_LIMIT,
      MAX_COST_LIMIT
    ),
    ipCostLimit: boundedInteger(
      env.AI_IP_COST_LIMIT_UNITS,
      DEFAULT_IP_COST_LIMIT,
      MAX_COST_LIMIT
    ),
    windowSeconds: boundedInteger(
      env.AI_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_WINDOW_SECONDS,
      MAX_WINDOW_SECONDS
    ),
    accountConcurrencyLimit: boundedInteger(
      env.AI_ACCOUNT_CONCURRENCY_LIMIT,
      DEFAULT_ACCOUNT_CONCURRENCY_LIMIT,
      MAX_CONCURRENCY_LIMIT
    ),
    ipConcurrencyLimit: boundedInteger(
      env.AI_IP_CONCURRENCY_LIMIT,
      DEFAULT_IP_CONCURRENCY_LIMIT,
      MAX_CONCURRENCY_LIMIT
    )
  };
}

/**
 * Charges against the maximum provider work exposed by one request. Output
 * tokens are the direct deployment-configured spend ceiling; drawings add
 * high-detail input processing on top of that ceiling.
 */
export function assistantQuotaCost(
  attachmentCount: number,
  maxOutputTokens: number
): number {
  const safeOutputTokens =
    Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? Math.ceil(maxOutputTokens)
      : OUTPUT_TOKEN_COST_UNIT;
  const safeAttachmentCount =
    Number.isInteger(attachmentCount) && attachmentCount > 0
      ? attachmentCount
      : 0;
  return (
    Math.max(1, Math.ceil(safeOutputTokens / OUTPUT_TOKEN_COST_UNIT)) +
    safeAttachmentCount * ATTACHMENT_COST_UNITS
  );
}

function jsonError(
  status: number,
  error: string,
  code: string,
  retryAfterSeconds?: number,
  rateLimit?: { limit: number; remaining: number }
): AssistantPermitDenied {
  return {
    allowed: false,
    response: new Response(
      JSON.stringify({
        error,
        code,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
      }),
      {
        status,
        headers: {
          'content-type': 'application/json',
          ...(retryAfterSeconds === undefined
            ? {}
            : { 'retry-after': String(retryAfterSeconds) }),
          ...(rateLimit
            ? {
                'x-ratelimit-limit': String(rateLimit.limit),
                'x-ratelimit-remaining': String(rateLimit.remaining)
              }
            : {})
        }
      }
    )
  };
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

async function opaqueIpBucket(
  request: Request,
  secret: string
): Promise<string | null> {
  const connectingIp = request.headers.get('cf-connecting-ip')?.trim();
  if (!connectingIp) {
    return null;
  }
  const digest = await hmacHex(`openzcad-ai-rate-v1:${connectingIp}`, secret);
  return `ip:${digest.slice(0, 32)}`;
}

async function consumeUsageBucket(
  db: D1Database,
  bucket: string,
  windowStart: number,
  cost: number
): Promise<UsageRow | null> {
  return db
    .prepare(
      `INSERT INTO ai_rate_limits
         (user_id, window_start, request_count, cost_units)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         window_start = excluded.window_start,
         request_count = CASE
           WHEN ai_rate_limits.window_start = excluded.window_start
             THEN ai_rate_limits.request_count + 1
           ELSE 1
         END,
         cost_units = CASE
           WHEN ai_rate_limits.window_start = excluded.window_start
             THEN ai_rate_limits.cost_units + excluded.cost_units
           ELSE excluded.cost_units
         END
       RETURNING request_count, cost_units`
    )
    .bind(bucket, windowStart, cost)
    .first<UsageRow>();
}

async function consumeGlobalDailyBudget(
  db: D1Database,
  dayStart: number,
  cost: number
): Promise<UsageRow | null> {
  return db
    .prepare(
      `INSERT INTO ai_global_daily_usage
         (day_start, request_count, cost_units)
       VALUES (?, 1, ?)
       ON CONFLICT(day_start) DO UPDATE SET
         request_count = ai_global_daily_usage.request_count + 1,
         cost_units = ai_global_daily_usage.cost_units + excluded.cost_units
       RETURNING request_count, cost_units`
    )
    .bind(dayStart, cost)
    .first<UsageRow>();
}

function overUsageLimit(
  row: UsageRow | null,
  requestLimit: number,
  costLimit: number
): boolean {
  return !row || row.request_count > requestLimit || row.cost_units > costLimit;
}

function trackedResponse(
  response: Response,
  release: () => Promise<void>
): Response {
  if (!response.body) {
    void release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await release();
          // Do not expose stream completion until the next turn can acquire
          // the account/IP slot. Closing first lets the browser submit again
          // while the D1 delete is still pending, and the Worker runtime may
          // stop post-response work before that best-effort cleanup runs.
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        await release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await release();
      }
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export async function acquireAssistantPermit(
  request: Request,
  userId: UserId,
  env: CloudflareEnv,
  options: {
    cost: number;
    leaseMs: number;
    deploymentFunded?: boolean;
    now?: number;
  }
): Promise<AssistantPermitResult> {
  if (env.ENVIRONMENT === 'development') {
    return {
      allowed: true,
      async release() {},
      track(response) {
        return response;
      }
    };
  }
  if (!env.DB) {
    return jsonError(
      503,
      'The modeling assistant usage guard is unavailable.',
      'AI_GUARD_UNAVAILABLE'
    );
  }
  const identityPepper = env.AI_IDENTITY_PEPPER?.trim();
  if (!identityPepper) {
    return jsonError(
      503,
      'The modeling assistant usage guard is unavailable.',
      'AI_GUARD_UNAVAILABLE'
    );
  }
  const ipBucket = await opaqueIpBucket(request, identityPepper);
  if (!ipBucket) {
    return jsonError(
      503,
      'The modeling assistant usage guard is unavailable.',
      'AI_GUARD_UNAVAILABLE'
    );
  }

  const settings = guardSettings(env);
  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1_000);
  const windowMs = settings.windowSeconds * 1_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart + windowMs - now) / 1_000)
  );
  const dayStart = Math.floor(now / 86_400_000) * 86_400;
  const globalRetryAfterSeconds = Math.max(1, dayStart + 86_400 - nowSeconds);
  const accountBucket = `account:${userId}`;
  const leaseId = crypto.randomUUID();
  const leaseSeconds =
    Math.ceil(Math.max(5_000, options.leaseMs) / 1_000) + LEASE_GRACE_SECONDS;
  const expiresAt = nowSeconds + leaseSeconds;
  const safeCost =
    Number.isInteger(options.cost) && options.cost > 0
      ? Math.min(options.cost, MAX_COST_LIMIT)
      : 1;

  try {
    await env.DB.prepare(
      `DELETE FROM ai_concurrency_leases
       WHERE lease_id IN (
         SELECT lease_id
         FROM ai_concurrency_leases
         WHERE expires_at <= ?
         LIMIT 100
       )`
    )
      .bind(nowSeconds)
      .run();
    const lease = await env.DB.prepare(
      `INSERT INTO ai_concurrency_leases
         (lease_id, account_bucket, ip_bucket, expires_at)
       SELECT ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*)
         FROM ai_concurrency_leases
         WHERE account_bucket = ? AND expires_at > ?
       ) < ?
       AND (
         SELECT COUNT(*)
         FROM ai_concurrency_leases
         WHERE ip_bucket = ? AND expires_at > ?
       ) < ?
       RETURNING lease_id`
    )
      .bind(
        leaseId,
        accountBucket,
        ipBucket,
        expiresAt,
        accountBucket,
        nowSeconds,
        settings.accountConcurrencyLimit,
        ipBucket,
        nowSeconds,
        settings.ipConcurrencyLimit
      )
      .first<{ lease_id: string }>();
    if (!lease) {
      return jsonError(
        429,
        'Too many modeling assistant requests are already in progress.',
        'AI_CONCURRENCY_LIMITED',
        1
      );
    }

    let releasePromise: Promise<void> | undefined;
    const release = () => {
      releasePromise ??= env
        .DB!.prepare('DELETE FROM ai_concurrency_leases WHERE lease_id = ?')
        .bind(leaseId)
        .run()
        .then(() => undefined)
        .catch(() => {
          // The lease expires even if this best-effort early release fails.
          console.error('AI concurrency lease release failed.');
        });
      return releasePromise;
    };

    const accountUsage = await consumeUsageBucket(
      env.DB,
      accountBucket,
      windowStart,
      safeCost
    );
    const ipUsage = await consumeUsageBucket(
      env.DB,
      ipBucket,
      windowStart,
      safeCost
    );
    const accountLimited = overUsageLimit(
      accountUsage,
      settings.accountRequestLimit,
      settings.accountCostLimit
    );
    const ipLimited = overUsageLimit(
      ipUsage,
      settings.ipRequestLimit,
      settings.ipCostLimit
    );
    if (accountLimited || ipLimited) {
      await release();
      const requestLimit = accountLimited
        ? settings.accountRequestLimit
        : settings.ipRequestLimit;
      const requestCount = accountLimited
        ? (accountUsage?.request_count ?? requestLimit + 1)
        : (ipUsage?.request_count ?? requestLimit + 1);
      return jsonError(
        429,
        'The modeling assistant request limit has been reached.',
        'AI_RATE_LIMITED',
        retryAfterSeconds,
        {
          limit: requestLimit,
          remaining: Math.max(0, requestLimit - requestCount)
        }
      );
    }
    if (options.deploymentFunded !== false) {
      const globalUsage = await consumeGlobalDailyBudget(
        env.DB,
        dayStart,
        safeCost
      );
      const globalLimited = overUsageLimit(
        globalUsage,
        settings.globalDailyRequestLimit,
        settings.globalDailyCostLimit
      );
      if (globalLimited) {
        await release();
        return jsonError(
          429,
          'The modeling assistant daily deployment budget has been reached.',
          'AI_GLOBAL_BUDGET_EXHAUSTED',
          globalRetryAfterSeconds,
          {
            limit: settings.globalDailyRequestLimit,
            remaining: Math.max(
              0,
              settings.globalDailyRequestLimit -
                (globalUsage?.request_count ??
                  settings.globalDailyRequestLimit + 1)
            )
          }
        );
      }
    }

    return {
      allowed: true,
      release,
      track(response) {
        return trackedResponse(response, release);
      }
    };
  } catch {
    console.error('AI usage guard failed.');
    return jsonError(
      503,
      'The modeling assistant usage guard is unavailable.',
      'AI_GUARD_UNAVAILABLE'
    );
  }
}
