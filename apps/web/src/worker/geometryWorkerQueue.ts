/** A worker job with caller-owned requests distinguished from broadcasts. */
export interface QueuedGeometryJob {
  requestId?: string;
}

/**
 * Serializes kernel work while retaining only the newest queued broadcast.
 * Caller-owned jobs are never coalesced: every syncOnce/export promise must
 * receive exactly one terminal result even during a live rebuild storm.
 */
export class GeometryWorkerQueue<TJob extends QueuedGeometryJob> {
  private readonly explicitJobs: TJob[] = [];
  private pendingBroadcast: TJob | null = null;
  private running = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly run: (job: TJob) => Promise<void>) {}

  enqueue(job: TJob): void {
    if (job.requestId) {
      this.explicitJobs.push(job);
    } else {
      this.pendingBroadcast = job;
    }
    void this.drain();
  }

  whenIdle(): Promise<void> {
    if (!this.running && !this.hasQueuedJob()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private hasQueuedJob(): boolean {
    return this.explicitJobs.length > 0 || this.pendingBroadcast !== null;
  }

  private nextJob(): TJob | null {
    const explicit = this.explicitJobs.shift();
    if (explicit) {
      return explicit;
    }
    const broadcast = this.pendingBroadcast;
    this.pendingBroadcast = null;
    return broadcast;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.hasQueuedJob()) {
        const job = this.nextJob();
        if (job) {
          await this.run(job);
        }
      }
    } finally {
      this.running = false;
      if (this.hasQueuedJob()) {
        void this.drain();
      } else {
        for (const resolve of this.idleWaiters) {
          resolve();
        }
        this.idleWaiters.clear();
      }
    }
  }
}
