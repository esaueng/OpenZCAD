/**
 * Truncates to a UTF-16 code-unit budget without splitting a character.
 *
 * A plain `slice(0, n)` counts code units, so a name whose nth unit is the
 * high half of a surrogate pair is cut between the halves and the result ends
 * in a lone surrogate — an ill-formed string that renders as the replacement
 * character wherever the name is shown, and is persisted that way. Shapr3D
 * names come from users and reach both the migration record and the UI, so an
 * emoji or a CJK extension character landing exactly on the boundary is all it
 * takes.
 *
 * The budget itself is deliberately still counted in code units. Slicing a
 * code-POINT array to the same number would quietly quadruple the real byte
 * ceiling, which is a limit change rather than a fix. This only ever returns
 * the same string or one code unit less.
 */
export function truncateCodeUnits(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const cut = value.slice(0, limit);
  const last = cut.charCodeAt(limit - 1);
  // A high surrogate in the final position had its low half cut away.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, limit - 1) : cut;
}
