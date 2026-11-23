/**
 * `@openzcad/kernel-adapter/exact` awaits the Remus runtime at load (top-level
 * await), so the bundler wraps every module in its graph in an async init.
 * A module that `exact.ts` imports and that value-imports `exact.ts` back
 * makes two of those inits await each other: the promise never settles, and
 * the geometry worker hangs in `loading-remus` with no error (PR #1977's
 * `units-reference-recapture.ts` did this and every e2e workspace stopped
 * opening). Type-only imports are erased and cannot cycle.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/kernel-adapter/src'
);
const EXACT = resolve(SOURCE, 'exact.ts');

/** Relative specifiers a module imports or re-exports as values. */
function valueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
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

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), base].find(
    (candidate) => candidate.endsWith('.ts') && existsSync(candidate)
  );
}

/** A value-import path from `exact.ts` back to itself, or undefined. */
function cycleThroughExact(): string[] | undefined {
  const seen = new Set<string>();
  const walk = (file: string, path: string[]): string[] | undefined => {
    for (const specifier of valueImports(file)) {
      const next = resolveModule(file, specifier);
      if (!next || !next.startsWith(SOURCE)) continue;
      if (next === EXACT) return [...path, 'exact.ts'];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next.slice(SOURCE.length + 1)]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(EXACT, ['exact.ts']);
}

describe('the exact kernel entry', () => {
  it('sees the value re-exports it walks', () => {
    // A walker that matched nothing would pass the cycle check vacuously.
    expect(valueImports(EXACT)).toContain('./units-reference-recapture');
  });

  it('has no value-import cycle back into exact.ts', () => {
    expect(cycleThroughExact()).toBeUndefined();
  });
});
