import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The adapter must not decide behaviour from the English of a kernel error.
 *
 * Every family with a typed twin on the pin now answers as data: the booleans
 * through `cutDetailed`/`fuseDetailed`/`intersectDetailed`, validation through
 * `validateSolidDetailed`, healing through `unifyFacesChecked`, and the STEP
 * reader through `importStepWithReport`. Prose matching is how those failures
 * used to be told apart, and it is the thing that silently rots: the kernel is
 * free to reword a diagnostic in any release, and a regex that stops matching
 * fails open — the branch simply never fires again and nobody hears about it.
 *
 * So this scans the adapter for a message being inspected as text and fails
 * unless the site is listed below with the family it belongs to and the reason
 * that family has no typed twin. An allowance that no longer matches anything
 * fails as stale, so the list cannot quietly rot either.
 */
const ADAPTER_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'kernel-adapter',
  'src'
);

interface ProseAllowance {
  /** Path relative to the adapter's `src`. */
  readonly file: string;
  /** A fragment of the offending line, enough to identify it. */
  readonly fragment: string;
  /** Which kernel family, and why it still has to read English. */
  readonly reason: string;
}

/**
 * Every remaining place the adapter reads a kernel sentence.
 *
 * All three belong to the blend family. `fillet`, `chamfer` and
 * `filletVariable` have no `*Detailed` twin on this pin: they throw a bare
 * Error and the only machine-readable thing in it is the prefix the kernel's
 * blend failure code writes into the prose. Until that family gains a typed
 * result, relaying the counts it names is better than dropping them — the
 * kernel is the only thing that knows which edges its blend engines gave up
 * on — and it is recorded here rather than pretended away.
 */
const ALLOWANCES: readonly ProseAllowance[] = [
  {
    file: 'exact-edge-modifiers.ts',
    fragment: 'of the edges named were not blended',
    reason:
      'blend family: fillet/chamfer have no typed twin on the pin, and this ' +
      'relays the kernel’s own refused-edge count.'
  },
  {
    file: 'exact-edge-modifiers.ts',
    fragment: 'would round on their own',
    reason: 'blend family: the matching half of the refused-edge count above.'
  },
  {
    file: 'exact-edge-modifiers.ts',
    fragment: 'unsupported vertex blend',
    reason:
      'blend family: the kernel names the shared-corner case only in its ' +
      'prose, and this cause is claimed only when it actually reported it.'
  },
  {
    file: 'exact-edge-modifiers.ts',
    fragment: 'available radius',
    reason:
      'blend family: fillet/chamfer have no typed twin on the pin, and the ' +
      'kernel names its measured blend ceiling only in its refusal prose; ' +
      'this aims the probe ladder and is never quoted.'
  }
];

/**
 * A message being tested as text.
 *
 * Two shapes, which is what every prose matcher in this repo has ever been:
 * a substring test against a string literal, and a regex literal exercised
 * with `.test(` or `.exec(`. Both are required to contain a word gap — a
 * literal space, or `\s` in a pattern — because that is what separates a
 * SENTENCE from an identifier. `startsWith('feat_')`, an array
 * `.includes(handle)` and `/^\d+$/.test(key)` are matching structure, not
 * English, and they are not what rots when the kernel rewords a diagnostic.
 */
const SUBSTRING_MATCH =
  /\.(?:includes|startsWith|endsWith|indexOf|search)\(\s*(['"`])([^'"`]*\s[^'"`]*)\1/g;
const REGEX_MATCH =
  /\/(?![/*])((?:[^/\\\n]|\\.)*(?: |\\s)(?:[^/\\\n]|\\.)*)\/[gimsuy]*\s*\.(?:test|exec)\(/g;

interface ProseSite {
  file: string;
  line: number;
  text: string;
  fragment: string;
}

function sourceFiles(): string[] {
  return readdirSync(ADAPTER_SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

function proseSites(): ProseSite[] {
  const sites: ProseSite[] = [];
  for (const name of sourceFiles()) {
    const source = readFileSync(join(ADAPTER_SRC, name), 'utf8');
    source.split('\n').forEach((text, index) => {
      const code = text.trimStart();
      // Comments describe the kernel's wording constantly and correctly.
      if (
        code.startsWith('//') ||
        code.startsWith('*') ||
        code.startsWith('/*')
      ) {
        return;
      }
      for (const pattern of [SUBSTRING_MATCH, REGEX_MATCH]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          sites.push({
            file: name,
            line: index + 1,
            text: text.trim(),
            fragment: (match[2] ?? match[1] ?? '').trim()
          });
        }
      }
    });
  }
  return sites;
}

function matches(site: ProseSite, allowance: ProseAllowance): boolean {
  return site.file === allowance.file && site.text.includes(allowance.fragment);
}

describe('kernel error prose in the adapter', () => {
  /**
   * The regression this whole seam exists to prevent: a migrated family
   * growing a new English matcher because someone needed to tell two
   * failures apart and reached for the sentence.
   */
  it('matches no kernel prose outside the recorded allowances', () => {
    const unlisted = proseSites().filter(
      (site) => !ALLOWANCES.some((allowance) => matches(site, allowance))
    );
    expect(
      unlisted.map((site) => `${site.file}:${site.line} ${site.text}`)
    ).toEqual([]);
  });

  /** An allowance that stopped matching is a claim about code that is gone. */
  it('carries no stale allowance', () => {
    const sites = proseSites();
    const stale = ALLOWANCES.filter(
      (allowance) => !sites.some((site) => matches(site, allowance))
    );
    expect(stale.map((entry) => `${entry.file}: ${entry.fragment}`)).toEqual(
      []
    );
  });

  /** Every allowance says which family it belongs to and why. */
  it('explains every allowance', () => {
    for (const allowance of ALLOWANCES) {
      expect(allowance.reason.length, allowance.fragment).toBeGreaterThan(40);
      expect(allowance.reason, allowance.fragment).toMatch(/family/);
    }
  });

  /**
   * The migrated families, named. This fails if a future change deletes the
   * typed reader and quietly goes back to the untyped call — the seam would
   * still have no prose matcher and the test above would still pass.
   */
  it('keeps every migrated family reading its typed kernel result', () => {
    const read = (name: string) =>
      readFileSync(join(ADAPTER_SRC, name), 'utf8');
    expect(read('exact-boolean-refusal.ts')).toContain('fuseDetailed');
    expect(read('kernel-validation.ts')).toContain('validateSolidDetailed');
    expect(read('kernel-validation.ts')).toContain('unifyFacesChecked');
    expect(read('kernel-step-import.ts')).toContain('importStepWithReport');
    // And the taxonomy stays derived from the pin rather than restated.
    expect(read('kernel-refusal.ts')).toContain('SolidOperationDetailedResult');
  });

  /**
   * The paired half of the migration: the adapter must not go back to the
   * bare `unifyFaces` + `validateSolid` pair at a site that now describes its
   * failure. Both bare calls are still legitimate elsewhere — a guard that
   * only chooses a branch has no sentence to improve and pays no JSON — so
   * this pins the sites that were converted rather than banning the calls.
   */
  it('keeps the converted cleanup gates on unifyFacesChecked', () => {
    for (const name of ['exact-cylinder-ops.ts', 'exact-direct-edit-ops.ts']) {
      const source = readFileSync(join(ADAPTER_SRC, name), 'utf8');
      expect(source, name).toContain('unifyAndRequireValidSolid');
      expect(source, name).not.toContain('kernel.unifyFaces(');
    }
  });

  it('scans a real adapter, not an empty directory', () => {
    expect(sourceFiles().length).toBeGreaterThan(40);
    expect(relative(ADAPTER_SRC, ADAPTER_SRC)).toBe('');
  });
});
