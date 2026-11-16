type Git = (
  args: string[],
  options?: { allowFailure?: boolean }
) => string | null;

export interface PromotionPlan {
  target: string;
  current: string | null;
  commits: string[];
  migrations: string[];
}

export function planPromotion(
  target: string | undefined,
  options?: { git?: Git }
): PromotionPlan;

export function promote(
  target: string | undefined,
  options?: { git?: Git; dryRun?: boolean; log?: (line: string) => void }
): PromotionPlan;
