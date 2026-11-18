export function kernelPin(lockfile: string): string;
export function checkDeclaration(
  base: string,
  head: string,
  options: { event: string; headRef?: string; labels?: string[] }
): { previous: string; current: string };
export function kernelComparisonBase(
  eventName: string | undefined,
  event: {
    pull_request?: { base?: { sha?: string }; head?: { sha?: string } };
    merge_group?: { base_sha?: string };
  },
  checkedCommit: string
): string;
