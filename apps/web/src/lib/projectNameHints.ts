import { MAX_PROJECT_NAME_LENGTH } from '@openzcad/shared';

/** Why a typed name cannot be used, or null when it can. */
export function projectNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'A project needs a name.';
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH)
    return `Use ${MAX_PROJECT_NAME_LENGTH} characters or fewer.`;
  return null;
}

/**
 * Another project already called this, ignoring case and the spaces around
 * it — the hint a second "Bracket A" never had. Names may repeat; this only
 * says so.
 */
export function sameNamedProject(
  name: string,
  others: ReadonlyArray<{ projectId: string; name: string }>,
  exceptProjectId?: string
): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return (
    others.find(
      (other) =>
        other.projectId !== exceptProjectId &&
        other.name.trim().toLowerCase() === wanted
    )?.name ?? null
  );
}
