export function changedPaths(base: string, cwd?: string): string[];
export function changedBrowserSpecs(
  base: string | undefined,
  all: string[],
  cwd?: string
): string[];
export function browserSpecsFromChanges(
  paths: string[],
  all: string[]
): string[];
export function selectCI(
  paths: string[],
  options?: { event?: string; labels?: string[]; deleted?: boolean }
): { unit: 'full' | 'smoke'; e2e: 'full' | 'smoke' };
