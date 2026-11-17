/** Ephemeral worker diagnostics; never persisted in the CAD document. */
export interface RebuildProgress {
  stage: 'sources' | 'history' | 'feature' | 'checkpoint' | 'measurement';
  name: string;
  index: number;
  total: number;
  status: 'started' | 'completed';
  durationMs?: number;
  /**
   * A completed `feature` stage only: whether the feature built or the
   * rebuild recorded it as failed or refused. `completed` says the stage
   * finished, not that it succeeded — the debug log used to read as a
   * success for a feature the UI showed as failed (QA 2026-11-14).
   */
  outcome?: 'built' | 'failed';
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
    return (outcome?: RebuildProgress['outcome']) =>
      emit({
        stage,
        name,
        index,
        total,
        status: 'completed',
        durationMs: Math.max(0, performance.now() - start),
        ...(outcome ? { outcome } : {})
      });
  };
}
