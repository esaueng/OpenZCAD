import { lstatSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/** Other checkouts must not receive private artifacts either. */
function rejectGitCheckout(path: string): void {
  let directory = resolve(path);
  for (;;) {
    let checkout = false;
    try {
      const marker = join(directory, '.git');
      // An empty directory named .git is not a checkout. Real Git directories
      // require HEAD; linked worktrees instead have a .git file.
      if (lstatSync(marker).isDirectory()) lstatSync(join(marker, 'HEAD'));
      checkout = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      )
        throw pathResolutionError(error);
    }
    if (checkout)
      throw new Error('Private artifacts must remain outside Git checkouts.');
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/**
 * Keep samples and every derived artifact outside the source checkout. Return
 * canonical paths so callers never validate one directory and write another.
 */
export function privateArtifactPaths(
  output: string | undefined,
  repository = REPOSITORY,
  inputs: readonly string[] = []
) {
  if (!output || !isAbsolute(output))
    throw new Error(
      'Set an absolute private output path outside the repository.'
    );
  const root = realpathSync(repository);
  const sources = inputs.map((input) => {
    try {
      const path = realpathSync(resolve(input));
      const identity = statSync(path, { bigint: true });
      if (!identity.isFile())
        throw new Error('Private source inputs must be existing files.');
      return { path, identity };
    } catch (error) {
      throw pathResolutionError(error);
    }
  });
  const rejectInputs = (path: string) => {
    if (sources.length === 0) return;
    let identity: BigIntStats | undefined;
    try {
      identity = statSync(path, { bigint: true });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw pathResolutionError(error);
    }
    if (
      sources.some(
        (source) =>
          within(path, source.path) ||
          within(source.path, path) ||
          (identity?.dev === source.identity.dev &&
            identity.ino === source.identity.ino)
      )
    )
      throw new Error('Private artifacts must not overlap a source input.');
  };
  const rejectRepository = (path: string) => {
    if (within(root, path))
      throw new Error('Private artifacts must remain outside the repository.');
  };
  const lexicalOutput = resolve(output);
  rejectRepository(lexicalOutput);
  rejectGitCheckout(dirname(lexicalOutput));
  rejectRepository(canonicalPath(dirname(lexicalOutput)));
  const canonicalOutput = canonicalPath(lexicalOutput);
  const directory = dirname(canonicalOutput);
  rejectRepository(canonicalOutput);
  rejectRepository(directory);
  rejectGitCheckout(directory);
  rejectInputs(canonicalOutput);
  const artifactDirectory = (path: string) => {
    if (!isAbsolute(path))
      throw new Error('Private artifact directories must be absolute.');
    const lexicalTarget = resolve(path);
    rejectRepository(lexicalTarget);
    const target = canonicalPath(lexicalTarget);
    rejectRepository(target);
    rejectInputs(target);
    rejectGitCheckout(lexicalTarget);
    rejectGitCheckout(target);
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
      throw new Error('Private artifact targets must not overlap the sample.');
    return target;
  };
  return {
    output: canonicalOutput,
    directory,
    inputs: sources.map((source) => source.path),
    artifactDirectory,
    artifact(name: string) {
      const lexicalTarget = resolve(directory, name);
      const target = artifactDirectory(lexicalTarget);
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

/** Validate CLI destinations while config loads, before Playwright cleans them. */
export function privatePlaywrightOutput(
  paths: ReturnType<typeof privateArtifactPaths>,
  argv: readonly string[],
  lastRunOutput?: string
): string {
  const values = (option: string) => {
    const found: string[] = [];
    for (let index = 0; index < argv.length && argv[index] !== '--'; index++) {
      const argument = argv[index]!;
      if (argument.startsWith(`${option}=`))
        found.push(argument.slice(option.length + 1));
      else if (argument === option) {
        const value = argv[++index];
        if (!value)
          throw new Error('Private probe output option needs a value.');
        found.push(value);
      }
    }
    return found;
  };
  for (const reporters of [
    ...values('--reporter'),
    ...values('--add-reporter')
  ]) {
    if (
      reporters
        .split(',')
        .some((reporter) => !['list', 'line', 'dot', 'null'].includes(reporter))
    )
      throw new Error(
        'Private probes support only stdout reporters: list, line, dot, null.'
      );
  }
  for (const file of [
    ...values('--last-failed-file'),
    ...(lastRunOutput ? [lastRunOutput] : [])
  ])
    paths.artifactDirectory(resolve(file));
  const outputs = values('--output').map((path) =>
    paths.artifactDirectory(resolve(path))
  );
  return outputs.at(-1) ?? paths.artifact('h02-private-playwright-artifacts');
}
