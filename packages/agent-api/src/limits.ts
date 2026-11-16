import { AgentToolError } from './errors';

/**
 * Per-process call budgets (docs/plans/l14-agent-api-design.md, "Rate limits
 * and budgets"). They protect the user's own machine from an agent loop that
 * retries fast: exact derivation costs real CPU and memory.
 */
export interface AgentRateLimits {
  /** Read calls per minute (every tool call takes one). */
  readPerMinute: number;
  readBurst: number;
  /** Exact-kernel calls per minute (preflight, apply, uncached digest). */
  kernelPerMinute: number;
  kernelBurst: number;
}

export const DEFAULT_AGENT_RATE_LIMITS: Readonly<AgentRateLimits> =
  Object.freeze({
    readPerMinute: 120,
    readBurst: 30,
    kernelPerMinute: 12,
    kernelBurst: 4
  });

/** A derivation is cancelled after this long. */
export const DEFAULT_KERNEL_TIMEOUT_MS = 120_000;

/**
 * Applies user-requested limits. A flag may lower a default, never raise it:
 * the defaults are the ceiling the design note commits to.
 */
export function boundedRateLimits(
  requested: Partial<AgentRateLimits> = {}
): AgentRateLimits {
  const limits = { ...DEFAULT_AGENT_RATE_LIMITS };
  for (const key of Object.keys(requested) as (keyof AgentRateLimits)[]) {
    const value = requested[key];
    if (value === undefined) continue;
    if (!(key in DEFAULT_AGENT_RATE_LIMITS))
      throw new Error(`Unknown rate limit "${String(key)}".`);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Rate limit ${key} must be a positive whole number.`);
    if (value > DEFAULT_AGENT_RATE_LIMITS[key])
      throw new Error(
        `Rate limit ${key} may be lowered, not raised above ${DEFAULT_AGENT_RATE_LIMITS[key]}.`
      );
    limits[key] = value;
  }
  return limits;
}

/** A refilling token bucket; `now` is injectable for tests. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly perMinute: number,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  /** Takes one token, or throws `rate_limited` with when to retry. */
  take(label: string): void {
    const now = this.now();
    const refill = ((now - this.updatedAt) * this.perMinute) / 60_000;
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, refill));
    this.updatedAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const retryAfterMs = Math.ceil(
      ((1 - this.tokens) * 60_000) / this.perMinute
    );
    throw new AgentToolError(
      'rate_limited',
      `The ${label} rate limit (${this.perMinute} per minute) was reached. Retry in ${Math.ceil(retryAfterMs / 1000)} s.`,
      retryAfterMs
    );
  }
}

/**
 * Serializes exact-kernel jobs: one runs, at most one waits, and a further
 * call is refused as busy instead of queueing without bound. A job that runs
 * past its budget is reported as a timeout at once and signalled to stop, but
 * it keeps the kernel until it actually settles, so two derivations never
 * share the kernel.
 */
export class KernelGate {
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly timeoutMs: number = DEFAULT_KERNEL_TIMEOUT_MS) {}

  get queued(): number {
    return this.pending;
  }

  async run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.pending >= 2)
      throw new AgentToolError(
        'busy',
        'The exact kernel is busy with another call and one more is waiting. Retry when one finishes.',
        1_000
      );
    this.pending += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    const controller = new AbortController();
    const work = Promise.resolve().then(() => job(controller.signal));
    void work
      .catch(() => undefined)
      .finally(() => {
        this.pending -= 1;
        release();
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new AgentToolError(
            'timeout',
            `The exact derivation ran past ${Math.round(this.timeoutMs / 1000)} s and was cancelled. Nothing was applied.`
          )
        );
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
