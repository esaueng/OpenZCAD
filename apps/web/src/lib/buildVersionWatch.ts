/**
 * Notices a newer deployment while a tab stays open. The build writes
 * `build-meta.json` beside the bundle with the source commit; polling it and
 * comparing with the commit this tab loaded is how the workspace can offer a
 * reload before a lazy chunk disappears from under it.
 */

export const BUILD_META_PATH = '/build-meta.json';
export const BUILD_VERSION_POLL_MS = 5 * 60_000;

export interface BuildVersionWatchOptions {
  onNewVersion(commit: string): void;
  /** Identity embedded in the JavaScript this tab actually loaded. */
  runningCommit?: string;
  fetchMeta?: () => Promise<string | null>;
  intervalMs?: number;
  /** Receives a tick callback and returns a stop; defaults to setInterval + visibilitychange. */
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}

export async function fetchBuildCommit(
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response = await fetcher(
      `${BUILD_META_PATH}?cb=${Date.now().toString(36)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5_000) }
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { commit?: unknown };
    return typeof payload.commit === 'string' && payload.commit.length > 0
      ? payload.commit
      : null;
  } catch {
    return null;
  }
}

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const timer = window.setInterval(tick, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * Compare with the running bundle, including on the first read: a restored
 * tab may already be older than the server when the watch starts. Without an
 * embedded identity (development), fall back to the first successful read.
 */
export function watchBuildVersion({
  onNewVersion,
  runningCommit = import.meta.env.OZ_BUILD_COMMIT,
  fetchMeta = () => fetchBuildCommit(),
  intervalMs = BUILD_VERSION_POLL_MS,
  schedule = defaultSchedule
}: BuildVersionWatchOptions): () => void {
  let baseline: string | null = runningCommit?.trim() || null;
  let notified = false;
  let stopped = false;
  let inFlight = false;
  const tick = () => {
    if (stopped || notified || inFlight) return;
    inFlight = true;
    void fetchMeta()
      .then((commit) => {
        if (stopped || commit === null) return;
        if (baseline === null) {
          baseline = commit;
          return;
        }
        if (commit !== baseline) {
          notified = true;
          onNewVersion(commit);
        }
      })
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  const stopSchedule = schedule(tick, intervalMs);
  return () => {
    stopped = true;
    stopSchedule();
  };
}
