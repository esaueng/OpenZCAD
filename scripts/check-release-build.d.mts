export function checkReleaseBuild(options?: {
  repoRoot?: string;
  dist?: string;
}): { commit: string; files: number; manifestSha256: string };
