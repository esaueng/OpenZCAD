/**
 * The package must run in browsers, Web Workers and the Tauri WKWebView, so
 * its runtime source may use WebCrypto and web streams but no Node APIs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sourceDir = new URL('./', import.meta.url);
const runtimeFiles = readdirSync(sourceDir).filter(
  (name) =>
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    name !== 'test-support.ts'
);

describe('runtime portability', () => {
  it('finds the runtime sources', () => {
    expect(runtimeFiles).toContain('index.ts');
    expect(runtimeFiles).toContain('envelope.ts');
  });

  it.each(runtimeFiles)('%s uses no Node-only APIs or dependencies', (name) => {
    const source = readFileSync(new URL(name, sourceDir), 'utf8');
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\b(Buffer|process|__dirname)\b/);
    for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
      expect(specifier, `${name} imports ${specifier}`).toMatch(/^\.\//);
    }
  });

  it('the package declares no dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', sourceDir), 'utf8')
    ) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });
});
