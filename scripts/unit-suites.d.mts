export type UnitSuite = 'smoke' | 'full';
export type UnitProject = 'root' | 'web';
export const ROOT_FULL_INCLUDE: string[];
export function resolveUnitSuite(
  env?: Record<string, string | undefined>
): UnitSuite;
export function validateUnitFiles(
  project: UnitProject,
  files: unknown
): string[];
export function unitTestInclude(
  project: UnitProject,
  env?: Record<string, string | undefined>
): string[] | undefined;
