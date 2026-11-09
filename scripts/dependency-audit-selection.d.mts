export function selectDependencyAudits(
  paths: string[] | undefined,
  event: string
): { javascript: boolean; rust: boolean };
