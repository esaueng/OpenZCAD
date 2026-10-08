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
  let completedFeature: RebuildProgress | undefined;
  return (progress) => {
    // Checkpoints sit inside feature replay. Alternating them with features
    // must not turn a short build into hundreds of main-thread status tasks.
    const stage = progress.stage === 'checkpoint' ? 'feature' : progress.stage;
    const at = now();
    // Keep the final replayed feature observable even when its completion
    // falls inside the sample interval. It must precede the next phase.
    if (stage !== lastStage && completedFeature) {
      publish(completedFeature);
      completedFeature = undefined;
    }
    if (progress.stage === 'feature' && progress.status === 'completed') {
      completedFeature = progress;
    }
    if (stage !== lastStage || at - lastAt >= intervalMs) {
      lastStage = stage;
      lastAt = at;
      publish(progress);
      if (completedFeature === progress) completedFeature = undefined;
    }
  };
}
