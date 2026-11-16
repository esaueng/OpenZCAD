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

export const PROMOTE_COMMAND: string;

export function gitAt(cwd: string | undefined): Git;

export function promote(
  target: string | undefined,
  options?: {
    git?: Git;
    dryRun?: boolean;
    log?: (line: string) => void;
    environment?: Record<string, string | undefined>;
  }
): PromotionPlan;
