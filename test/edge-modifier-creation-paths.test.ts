import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every production path that creates a fillet or chamfer, and how it keeps
 * the edges' lineage names.
 *
 * A pick stored by hash alone survives an upstream edit only when the
 * rebuild can carry it (`exact-edge-selection-transport.ts`); a pick stored
 * with its `edgeReferences` follows the edit by name. So a creation path
 * must forward the names whenever the target body publishes them for every
 * picked edge (the command contract is all or nothing), and stays hash-only
 * only where the body names none of them — a fillet of a boolean result,
 * for example, which is why a reported Chamfer 2 was saved without names.
 *
 * A new call site, or one more in a listed file, fails here until it is
 * listed with how it records the names. That is the review this guard
 * forces: a new path that drops them would otherwise surface only when a
 * later resize refuses with "A selected edge no longer exists".
 */
const CREATION_PATHS: Record<string, { count: number; names: string }> = {
  'apps/web/src/App.tsx': {
    count: 2,
    names:
      'Viewport edge drag: the picked references, re-read from the current topology at commit (refreshEdgeFormReferencesForCommit).'
  },
  'apps/web/src/lib/edgeModifierEdit.ts': {
    count: 2,
    names:
      'Fillet/chamfer tool and card: the form value, whose references edgeModifierValue re-reads from the current topology at commit.'
  },
  'apps/web/src/lib/aiPatchPreflight.ts': {
    count: 2,
    names:
      'Staged AI modifier: selects only edges the exact body names, and stores every one of those names.'
  },
  'packages/command-system/src/index.ts': {
    count: 2,
    names:
      'AI add_edge_modifier operation: the patch supplies hashes only; preflight replaces staged selections with named ones.'
  },
  'apps/web/src/lib/demos.ts': {
    count: 4,
    names:
      'Demo builder: forwards the references where the demo body publishes them; the others are hash-only fixtures the carry tests exercise.'
  }
};

const CALL = /commandFactories\.(?:fillet|chamfer)Edges\(/g;

const ROOT = path.resolve(import.meta.dirname, '..');

/** Every non-test TypeScript source under an app's or a package's `src`. */
function productionSources(): string[] {
  const sources: string[] = [];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(ROOT, group), {
      withFileTypes: true
    })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(group, entry.name, 'src');
      let files: string[];
      try {
        files = readdirSync(path.join(ROOT, src), {
          recursive: true
        }) as string[];
      } catch {
        continue;
      }
      for (const file of files) {
        if (/\.(?:ts|tsx)$/.test(file) && !/\.(?:test|spec)\./.test(file))
          sources.push(path.join(src, file).split(path.sep).join('/'));
      }
    }
  }
  return sources;
}

describe('fillet and chamfer creation paths', () => {
  it('lists every path that creates one, with how it keeps edge names', () => {
    const found: Record<string, number> = {};
    for (const file of productionSources()) {
      const count =
        readFileSync(path.join(ROOT, file), 'utf8').match(CALL)?.length ?? 0;
      if (count > 0) found[file] = count;
    }
    expect(
      found,
      'A fillet/chamfer creation path changed. Forward edgeReferences when every picked edge is named (see refreshEdgeFormReferencesForCommit), then update CREATION_PATHS with how this path records them.'
    ).toEqual(
      Object.fromEntries(
        Object.entries(CREATION_PATHS).map(([file, { count }]) => [file, count])
      )
    );
  });
});
