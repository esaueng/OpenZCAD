import { accountAiLimits, type CloudflareEnv } from '@openzcad/cloudflare-adapters';
import type { UserId } from '@openzcad/shared';

const MAX_COST_LIMIT = 10_000;
const OUTPUT_TOKEN_COST_UNIT = 8_000;
const ATTACHMENT_COST_UNITS = 2;
const LEASE_GRACE_SECONDS = 30;

interface UsageRow {
  request_count: number;
  cost_units: number;
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
          // the account slot. Closing first lets the browser submit again
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
  _request: Request,
  userId: UserId,
  env: CloudflareEnv,
  options: {
    cost: number;
    leaseMs: number;
    deploymentFunded?: boolean;
    /** Verified server identity, never a request payload field. */
    email?: string;
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
  const settings = accountAiLimits(env, options.email);
  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1_000);
  const windowMs = settings.windowSeconds * 1_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart + windowMs - now) / 1_000)
  );
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
    // The old schema requires ip_bucket; use the account bucket because
    // concurrency is now limited by account only.
    const lease = await env.DB.prepare(
      `INSERT INTO ai_concurrency_leases
         (lease_id, account_bucket, ip_bucket, expires_at)
       SELECT ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*)
         FROM ai_concurrency_leases
         WHERE account_bucket = ? AND expires_at > ?
       ) < ?
       RETURNING lease_id`
    )
      .bind(
        leaseId,
        accountBucket,
        accountBucket,
        expiresAt,
        accountBucket,
        nowSeconds,
        settings.accountConcurrencyLimit
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

    // Per-account window quotas bound deployment-funded usage.
    // Self-funded requests (a personal provider credential) pay with the
    // user's own key, so only account concurrency and payload caps apply.
    if (options.deploymentFunded !== false) {
      const accountUsage = await consumeUsageBucket(
        env.DB,
        accountBucket,
        windowStart,
        safeCost
      );
      const accountLimited = overUsageLimit(
        accountUsage,
        settings.accountRequestLimit,
        settings.accountCostLimit
      );
      if (accountLimited) {
        await release();
        const requestLimit = settings.accountRequestLimit;
        const requestCount = accountUsage?.request_count ?? requestLimit + 1;
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
