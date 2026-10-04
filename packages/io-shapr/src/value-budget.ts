import type { ShaprImportLimits } from './limits';
const budgets = new WeakMap<ShaprImportLimits, { remaining: number }>();
export function workspaceValueLimits(
  limits: ShaprImportLimits
): ShaprImportLimits {
  const scoped = { ...limits };
  budgets.set(scoped, { remaining: 2_000_000 });
  return scoped;
}
export function consumeWorkspaceValue(limits: ShaprImportLimits): void {
  const budget = budgets.get(limits);
  if (budget && --budget.remaining < 0)
    throw new Error('SHAPR workspace exceeds the cumulative value limit.');
}
