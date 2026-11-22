export interface ReloadBudget {
  /** Substring of the H02 probe's scenario title. */
  match: string;
  reloadToReadyMs: number;
  settledFirstEditMs: number;
  immediateEditMs: number;
}

export interface InteractionBudget {
  medianMs: number;
  p95Ms: number;
}

export interface FaceDragBudget {
  lagP50Ms?: number;
  lagP95Ms?: number;
  firstGeometryMs?: number;
  exactPreviewMs?: number;
  frameIntervalP50Ms?: number;
  frameIntervalP95Ms?: number;
  releaseToFrameMs?: number;
}

export interface OrbitBudget {
  p95Ms?: number;
  p99Ms?: number;
  minViewerFps?: number;
}

export const ACTIVE1_BUDGETS: Readonly<{
  firstEditAfterReload: readonly Readonly<ReloadBudget>[];
  interaction: Readonly<
    Record<'w01-box' | 'w01-history', Readonly<InteractionBudget>>
  >;
  interactionTargetMs: number;
  faceDrag: Readonly<Record<string, Readonly<FaceDragBudget>>>;
  faceDragTargets: Readonly<{
    frameIntervalMs: number;
    firstGeometryMs: number;
    lagP95Ms: number;
  }>;
  orbit: Readonly<Record<string, Readonly<OrbitBudget>>>;
  sustained: Readonly<{
    peakLinearMemoryMiB: number;
    peakRetiredSlots: number;
    heapGrowthMiB: number;
    editDriftRatio: number;
  }>;
  patternPreview10x10: Readonly<{
    nodeMedianMs: number;
    browserMedianMs: number;
  }>;
}>;
