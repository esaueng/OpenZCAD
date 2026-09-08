import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function pinRemus(manifest, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid Remus commit.');
  const next = structuredClone(manifest);
  for (const [name, path] of [
    ['remus-wasm', '/crates/wasm/pkg'],
    ['remus-wasm-io', '/crates/wasm-io/pkg']
  ]) {
    if (typeof next.dependencies?.[name] !== 'string') {
      throw new Error(`Missing ${name} dependency.`);
    }
    next.dependencies[name] = `github:esaueng/remus#${sha}&path:${path}`;
  }
  return next;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = 'packages/kernel-adapter/package.json';
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(
    path,
    `${JSON.stringify(pinRemus(manifest, process.argv[2] ?? ''), null, 2)}\n`
  );
}
