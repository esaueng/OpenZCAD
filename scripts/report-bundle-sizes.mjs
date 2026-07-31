import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const DIST = join(process.cwd(), 'apps', 'web', 'dist');
const REPORTED_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.wasm']);

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collect(path);
    }
    return REPORTED_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

const rows = collect(DIST)
  .map((path) => {
    const contents = readFileSync(path);
    return {
      file: relative(DIST, path).replaceAll('\\', '/'),
      bytes: contents.byteLength,
      gzipBytes: gzipSync(contents).byteLength
    };
  })
  .sort(
    (left, right) =>
      right.bytes - left.bytes || left.file.localeCompare(right.file)
  );

const totals = rows.reduce(
  (sum, row) => ({
    bytes: sum.bytes + row.bytes,
    gzipBytes: sum.gzipBytes + row.gzipBytes
  }),
  { bytes: 0, gzipBytes: 0 }
);

process.stdout.write(`${JSON.stringify({ rows, totals }, null, 2)}\n`);
