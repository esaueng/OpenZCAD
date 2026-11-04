import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const removedDependency = /occt|opencascade|io-freecad/i;

/** Keep the removed kernel out of runtime and development dependency graphs. */
describe('Remus kernel dependency boundary', () => {
  it('has no OCCT or FreeCAD converter dependency in any workspace manifest', () => {
    const manifests = ['package.json'];
    for (const group of ['apps', 'packages']) {
      for (const entry of readdirSync(join(ROOT, group), {
        withFileTypes: true
      })) {
        if (entry.isDirectory())
          manifests.push(`${group}/${entry.name}/package.json`);
      }
    }
    expect(manifests.length).toBeGreaterThan(10);
    for (const file of manifests) {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, file), 'utf8')
      ) as Partial<Record<string, Record<string, string>>>;
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies'
      ]) {
        expect(
          Object.keys(manifest[field] ?? {}).filter((name) =>
            removedDependency.test(name)
          ),
          file
        ).toEqual([]);
      }
    }
    expect(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')).not.toMatch(
      removedDependency
    );
  });

  it('keeps the application policy free of JavaScript unsafe-eval exceptions', () => {
    const headers = readFileSync(
      join(ROOT, 'apps/web/public/_headers'),
      'utf8'
    );
    expect(headers).not.toContain("'unsafe-eval'");
    expect(headers).toContain("'wasm-unsafe-eval'");
    for (const file of [
      'wrangler.jsonc',
      'apps/web/wrangler.jsonc',
      'wrangler.selfhost.example.jsonc'
    ]) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toContain(
        'freecadImportWorker'
      );
    }
  });
});
