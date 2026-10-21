import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));

function within(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function pathResolutionError(error: unknown) {
  // Retain the filesystem failure category without disclosing private paths.
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
  return new Error('Private artifact path cannot be resolved.', {
    cause: { code }
  });
}

/** Resolve existing symlinks, including above a not-yet-created suffix. */
function canonicalPath(path: string): string {
  let ancestor = resolve(path);
  for (;;) {
    let existing = false;
    try {
      lstatSync(ancestor);
      existing = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw pathResolutionError(error);
    }
    if (existing) {
      try {
        // A dangling symlink is an existing entry; realpath must reject it.
        return resolve(
          realpathSync(ancestor),
          relative(ancestor, resolve(path))
        );
      } catch (error) {
        throw pathResolutionError(error);
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error('Private artifact path cannot be resolved.');
    ancestor = parent;
  }
}

/**
 * Keep samples and every derived artifact outside the source checkout. Return
 * canonical paths so callers never validate one directory and write another.
 */
export function privateArtifactPaths(
  output: string | undefined,
  repository = REPOSITORY
) {
  if (!output || !isAbsolute(output))
    throw new Error(
      'Set an absolute private output path outside the repository.'
    );
  const root = realpathSync(repository);
  const rejectRepository = (path: string) => {
    if (within(root, path))
      throw new Error('Private artifacts must remain outside the repository.');
  };
  const lexicalOutput = resolve(output);
  rejectRepository(lexicalOutput);
  rejectRepository(canonicalPath(dirname(lexicalOutput)));
  const canonicalOutput = canonicalPath(lexicalOutput);
  const directory = dirname(canonicalOutput);
  rejectRepository(canonicalOutput);
  rejectRepository(directory);
  return {
    output: canonicalOutput,
    directory,
    artifact(name: string) {
      const lexicalTarget = resolve(directory, name);
      rejectRepository(lexicalTarget);
      const target = canonicalPath(lexicalTarget);
      rejectRepository(target);
      // Build/report tools may remove their whole target before writing. An
      // ancestor of the checkout is just as unsafe as a child of it.
      if (within(lexicalTarget, root) || within(target, root))
        throw new Error(
          'Private artifact targets must not overlap the repository.'
        );
      if (
        within(lexicalTarget, canonicalOutput) ||
        within(canonicalOutput, lexicalTarget) ||
        within(target, canonicalOutput) ||
        within(canonicalOutput, target)
      )
        throw new Error(
          'Private artifact targets must not overlap the sample.'
        );
      if (
        lexicalTarget === directory ||
        target === directory ||
        !within(directory, lexicalTarget) ||
        !within(directory, target)
      )
        throw new Error(
          'Private artifacts must remain in the output directory.'
        );
      return target;
    }
  };
}
