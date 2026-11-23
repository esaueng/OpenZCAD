/**
 * `@openzcad/kernel-adapter/exact` awaits the Remus runtime at load (top-level
 * await), so the bundler wraps every module in its graph in an async init.
 * A module that `exact.ts` imports and that value-imports `exact.ts` back
 * makes two of those inits await each other: the promise never settles, and
 * the geometry worker hangs in `loading-remus` with no error (PR #1977's
 * `units-reference-recapture.ts` did this and every e2e workspace stopped
 * opening). Type-only imports are erased and cannot cycle; a dynamic
 * `import()` runs after load and cannot either.
 *
 * The walk follows relative specifiers and workspace package specifiers
 * (`@openzcad/kernel-adapter/exact`, `@openzcad/document-core`, …) through
 * each package's `exports`, into every workspace package, so a cycle that
 * leaves the adapter's source directory or names `exact.ts` by its package
 * alias is still found.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'packages/kernel-adapter/src');
const EXACT = resolve(SOURCE, 'exact.ts');
const RECAPTURE = resolve(SOURCE, 'units-reference-recapture.ts');

/** Workspace package name → its directory and `exports` map. */
const PACKAGES = new Map(
  readdirSync(resolve(ROOT, 'packages')).flatMap((name) => {
    const directory = resolve(ROOT, 'packages', name);
    const manifest = resolve(directory, 'package.json');
    if (!existsSync(manifest)) return [];
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string;
      exports?: string | Record<string, string>;
      main?: string;
    };
    const exports =
      typeof json.exports === 'string'
        ? { '.': json.exports }
        : (json.exports ?? (json.main ? { '.': json.main } : {}));
    return [[json.name, { directory, exports }] as const];
  })
);

/** Specifiers a module imports or re-exports as values, at load. */
function valueImports(text: string): string[] {
  const specifiers: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(statement)) {
    if (match[5]) {
      specifiers.push(match[5]);
      continue;
    }
    if (match[2]) continue; // `import type` / `export type`
    const clause = match[3] ?? '';
    const braces = /\{([^}]*)\}/.exec(clause);
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/[\s,]/g, '');
    const named = braces
      ? braces[1]!
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : [];
    // A clause of only `type X` specifiers is erased like `import type`.
    if (
      outside.length === 0 &&
      named.length > 0 &&
      named.every((part) => part.startsWith('type '))
    )
      continue;
    specifiers.push(match[4]!);
  }
  return specifiers;
}

function existingModule(base: string): string | undefined {
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx')
  ].find(
    (candidate) =>
      (candidate.endsWith('.ts') || candidate.endsWith('.tsx')) &&
      existsSync(candidate)
  );
}

/**
 * The workspace source file `specifier` names from `from`, or undefined for
 * anything outside the workspace (`node:`, `vitest`, Remus, …).
 */
function resolveModule(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.'))
    return existingModule(resolve(dirname(from), specifier));
  const match = /^(@openzcad\/[^/]+)(?:\/(.+))?$/.exec(specifier);
  const workspace = match ? PACKAGES.get(match[1]!) : undefined;
  if (!workspace) return undefined;
  const subpath = match![2] ? `./${match![2]}` : '.';
  const target = workspace.exports[subpath];
  // A subpath the package does not export cannot be imported at all.
  return target
    ? existingModule(resolve(workspace.directory, target))
    : undefined;
}

/**
 * A value-import path from `exact.ts` back to itself, or undefined. `read`
 * supplies each file's text, so a test can try an import without writing it.
 */
function cycleThroughExact(
  read: (file: string) => string = (file) => readFileSync(file, 'utf8')
): string[] | undefined {
  const seen = new Set<string>();
  const walk = (file: string, path: string[]): string[] | undefined => {
    for (const specifier of valueImports(read(file))) {
      const next = resolveModule(file, specifier);
      if (!next || next.includes('/node_modules/')) continue;
      if (next === EXACT) return [...path, 'exact.ts'];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, relative(ROOT, next)]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(EXACT, ['exact.ts']);
}

describe('the exact kernel entry', () => {
  it('sees the value re-exports it walks', () => {
    // A walker that matched nothing would pass the cycle check vacuously.
    expect(valueImports(readFileSync(EXACT, 'utf8'))).toContain(
      './units-reference-recapture'
    );
    expect(resolveModule(RECAPTURE, '@openzcad/kernel-adapter/exact')).toBe(
      EXACT
    );
    expect(resolveModule(RECAPTURE, '@openzcad/document-core')).toBe(
      resolve(ROOT, 'packages/document-core/src/index.ts')
    );
  });

  it('has no value-import cycle back into exact.ts', () => {
    expect(cycleThroughExact()).toBeUndefined();
  });

  it('finds a cycle through the package alias, which the review missed', () => {
    const withAlias = (file: string) => {
      const text = readFileSync(file, 'utf8');
      return file === RECAPTURE
        ? `import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';\n${text}`
        : text;
    };
    expect(cycleThroughExact(withAlias)).toEqual([
      'exact.ts',
      'packages/kernel-adapter/src/units-reference-recapture.ts',
      'exact.ts'
    ]);
  });
});
