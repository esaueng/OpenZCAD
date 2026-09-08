export function pinRemus<T extends { dependencies: Record<string, string> }>(
  manifest: T,
  sha: string
): T;
