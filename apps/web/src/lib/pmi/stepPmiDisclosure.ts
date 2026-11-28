import { MODEL_PMI_UNVERIFIED_WARNING_PREFIX } from '@openzcad/shared';

/**
 * #2258/#2321: what an AP242 STEP export says about its model PMI, so a
 * geometry-only file is never reported as a complete semantic handoff and
 * a form tolerance written on a freeform face is never passed off as
 * checked. `warnings` is the export's warnings: one "<entry> — <reason>"
 * per entry left out, and one "face type not verified: <characteristic> on
 * a freeform face" per form tolerance written without its face's surface
 * being known.
 */
function splitWarnings(warnings: readonly string[]): {
  omitted: string[];
  unverified: string[];
} {
  const omitted: string[] = [];
  const unverified: string[] = [];
  for (const warning of warnings)
    (warning.startsWith(MODEL_PMI_UNVERIFIED_WARNING_PREFIX)
      ? unverified
      : omitted
    ).push(warning);
  return { omitted, unverified };
}

const entries = (count: number) =>
  count === 1 ? '1 PMI entry' : `${count} PMI entries`;

/** The status line's note; null when the export said nothing about PMI. */
export function stepPmiOmissionNote(
  warnings: readonly string[]
): string | null {
  const { omitted, unverified } = splitWarnings(warnings);
  const notes = [
    ...(omitted.length > 0
      ? [`AP242 left out ${entries(omitted.length)}: ${omitted.join('; ')}.`]
      : []),
    ...(unverified.length > 0
      ? [
          `AP242 wrote ${entries(unverified.length)} unchecked: ${unverified.join('; ')}.`
        ]
      : [])
  ];
  return notes.length > 0 ? notes.join(' ') : null;
}

/**
 * The activity card's clause for the same export:
 * "1 body; 1 PMI entry left out; 2 PMI entries unchecked".
 */
export function stepPmiOmissionClause(
  bodies: string,
  warnings: readonly string[]
): string {
  const { omitted, unverified } = splitWarnings(warnings);
  return [
    bodies,
    ...(omitted.length > 0 ? [`${entries(omitted.length)} left out`] : []),
    ...(unverified.length > 0
      ? [`${entries(unverified.length)} unchecked`]
      : [])
  ].join('; ');
}
