import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The OpenCascade reference must not run in the default suite.
 *
 * Z5 removed OpenCascade from the production adapter and relocated it to
 * `test/parity/occt-reference/` as a parity reference. The intent, stated in
 * `test/parity/vitest.corpus.config.ts`, is that it boots in the corpus job
 * ALONE: the corpus imports every file through two WASM kernels, and the root
 * suite already had to bound its worker count once to stop kernel startup from
 * turning into unrelated five-second timeouts.
 *
 * The mechanism is a naming convention — corpus suites are `*.spec.ts` and the
 * root config's `include` matches only `*.test.ts`. That convention is
 * invisible at the point where it gets broken, which is exactly what happened:
 * the relocation in Z5 brought `occt-lineage` and `occt-modeling-operations`
 * across as `.test.ts`, and a later merge added a third, so the default
 * `pnpm test` run booted OpenCascade for three files without anything saying
 * so. The corpus config's own header warns about it in prose. Prose does not
 * fail a build.
 *
 * So this asserts the convention instead of documenting it. It reads the
 * files the root config would collect and checks that none of them reaches
 * OpenCascade — by import, not by mention, since several suites legitimately
 * discuss `occt-step.ts` in comments while having nothing to do with it.
 */
const OCCT_IMPORT =
  /^\s*(?:import|export)[\s\S]*?from\s+['"](?:occt-wasm[^'"]*|[^'"]*occt-(?:step|lineage|modeling-operations)[^'"]*)['"]/gm;

/** Mirrors `include` in vitest.config.ts. */
function defaultSuiteFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.test.tsx')
      ) {
        found.push(path);
      } else if (extname(entry.name) === '') {
        continue;
      }
    }
  };
  walk(join(ROOT, 'test'));
  walk(join(ROOT, 'packages'));
  return found;
}

describe('the OpenCascade reference stays out of the default suite', () => {
  it('collects a plausible number of default-suite files', () => {
    // Non-vacuity. A selector that found nothing would satisfy the assertion
    // below trivially, which is the exact failure this project has hit before.
    expect(defaultSuiteFiles().length).toBeGreaterThan(50);
  });

  it('has no default-suite file importing OpenCascade', () => {
    const offenders = defaultSuiteFiles()
      .filter((path) => path !== fileURLToPath(import.meta.url))
      .filter((path) => {
        OCCT_IMPORT.lastIndex = 0;
        return OCCT_IMPORT.test(readFileSync(path, 'utf8'));
      })
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });

  it('still keeps the reference suites, under the corpus naming convention', () => {
    // The other half of the claim. Moving the files out of the default run is
    // only correct if they still run SOMEWHERE — a rename that silently
    // stopped exercising OpenCascade would pass the assertion above and lose
    // the parity coverage Z5 kept the reference for.
    const reference = readdirSync(
      join(ROOT, 'test', 'parity', 'occt-reference')
    );
    const suites = reference.filter((name) => name.endsWith('.spec.ts'));
    expect(suites.length).toBeGreaterThanOrEqual(3);
    expect(reference.filter((name) => name.endsWith('.test.ts'))).toEqual([]);
  });
});
