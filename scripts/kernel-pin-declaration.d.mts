export function kernelPin(lockfile: string): string;
export function checkDeclaration(
  base: string,
  head: string,
  options: { event: string; headRef?: string; labels?: string[] }
): { previous: string; current: string };
