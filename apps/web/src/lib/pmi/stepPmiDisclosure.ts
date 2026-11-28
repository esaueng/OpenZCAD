/**
 * #2258: what an AP242 STEP export says when it leaves model PMI out, so a
 * geometry-only file is never reported as a complete semantic handoff.
 * `omitted` is the export's warnings, one "<entry> — <reason>" each.
 */
export function stepPmiOmissionNote(omitted: readonly string[]): string | null {
  if (omitted.length === 0) return null;
  const count =
    omitted.length === 1 ? '1 PMI entry' : `${omitted.length} PMI entries`;
  return `AP242 left out ${count}: ${omitted.join('; ')}.`;
}

/** The activity card's clause for the same export: "1 body; 1 PMI entry left out". */
export function stepPmiOmissionClause(
  bodies: string,
  omitted: readonly string[]
): string {
  if (omitted.length === 0) return bodies;
  const count =
    omitted.length === 1 ? '1 PMI entry' : `${omitted.length} PMI entries`;
  return `${bodies}; ${count} left out`;
}
