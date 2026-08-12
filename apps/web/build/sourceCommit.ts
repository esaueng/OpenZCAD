/**
 * Resolves the source commit stamped into `build-meta.json`.
 *
 * This lives in its own module so the environment-variable chain can be
 * tested. The chain is the part that breaks: it is exercised only inside a
 * CI container, where getting it wrong fails a deploy rather than a test.
 */
export function resolveSourceCommit(
  env: Record<string, string | undefined>,
  gitHead: () => string | null
): string {
  const supplied =
    env.OPENZCAD_BUILD_COMMIT ??
    env.GITHUB_SHA ??
    // Workers Builds — what openzcad actually deploys through.
    env.WORKERS_CI_COMMIT_SHA ??
    // Pages equivalent, kept for anything still building that way.
    env.CF_PAGES_COMMIT_SHA;
  if (supplied?.trim()) {
    return supplied.trim();
  }
  // Last resort. A build container that copies the tree without .git has no
  // answer here, and 'unknown' is rejected by the build-meta provenance gate
  // rather than shipped — this fails closed on purpose.
  return gitHead()?.trim() || 'unknown';
}
