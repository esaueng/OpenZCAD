/** Ephemeral worker diagnostics; never persisted in the CAD document. */
export interface RebuildProgress {
  stage: 'sources' | 'history' | 'feature' | 'checkpoint' | 'measurement';
  name: string;
  index: number;
  total: number;
  status: 'started' | 'completed';
  durationMs?: number;
}

export type RebuildProgressListener = (progress: RebuildProgress) => void;

/** Diagnostic observers cannot change geometry acceptance or interrupt work. */
export function rebuildReporter(listener?: RebuildProgressListener) {
  const emit = (progress: RebuildProgress) => {
    try {
      listener?.(progress);
    } catch {
      // Reporting is best effort; geometry remains authoritative.
    }
  };
  return (
    stage: RebuildProgress['stage'],
    name: string,
    index = 0,
    total = 0
  ) => {
    const start = performance.now();
    emit({ stage, name, index, total, status: 'started' });
    return () =>
      emit({
        stage,
        name,
        index,
        total,
        status: 'completed',
        durationMs: Math.max(0, performance.now() - start)
      });
  };
}
