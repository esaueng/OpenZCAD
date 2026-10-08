import type {
  RebuildProgress,
  RebuildProgressListener
} from '@openzcad/kernel-adapter/exact';

/** UI progress is sampled; geometry and the adapter's stage timings are unchanged. */
export function geometryProgress(
  publish: RebuildProgressListener,
  now: () => number = () => performance.now(),
  intervalMs = 50
): RebuildProgressListener {
  let lastAt = -Infinity;
  let lastStage: RebuildProgress['stage'] | undefined;
  return (progress) => {
    // Checkpoints sit inside feature replay. Alternating them with features
    // must not turn a short build into hundreds of main-thread status tasks.
    const stage = progress.stage === 'checkpoint' ? 'feature' : progress.stage;
    const at = now();
    if (stage !== lastStage || at - lastAt >= intervalMs) {
      lastStage = stage;
      lastAt = at;
      publish(progress);
    }
  };
}
