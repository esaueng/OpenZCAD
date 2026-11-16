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

export const ACTIVE1_BUDGETS: Readonly<{
  firstEditAfterReload: readonly Readonly<ReloadBudget>[];
  interaction: Readonly<
    Record<'w01-box' | 'w01-history', Readonly<InteractionBudget>>
  >;
  interactionTargetMs: number;
  patternPreview10x10: Readonly<{
    nodeMedianMs: number;
    browserMedianMs: number;
  }>;
}>;
