/** Keep engine diagnostics available while leading with a useful recovery. */
export function modelingRefusalSummary(reason: string): string | null {
  if (
    /empty result:.*(?:cut|subtract).*target fully contained in tool/i.test(
      reason
    )
  ) {
    return 'This cut would remove the entire target body. Reduce its size or move it.';
  }
  return null;
}
