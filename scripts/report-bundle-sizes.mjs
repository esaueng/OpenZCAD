import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const REPORTED_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.wasm']);
const CHECK = process.argv.includes('--check');
const DEFAULT_RAW_BUDGET = 500 * 1024;
const APPROVED_LAZY_ASSETS = [
  {
    pattern: /^assets\/three-.*\.js$/,
    maxBytes: 600 * 1024,
    reason: '3D engine, loaded only for a workspace or non-empty thumbnail'
  },
  {
    pattern: /^assets\/pdf\.worker\.min-.*\.js$/,
    maxBytes: 1_300 * 1024,
    reason: 'PDF parsing worker, loaded only for PDF attachments'
  },
  {
    pattern: /^assets\/brepkit_wasm_bg-.*\.wasm$/,
    maxBytes: 6 * 1024 * 1024,
    reason: 'Exact geometry kernel, loaded only for non-empty geometry'
  }
];
const LAZY_ENTRY_PATTERNS = [
  /^assets\/(?:three|three-addons)-.*\.js$/,
  /^assets\/(?:ViewerShell|partThumbnail|pdf|exact|src)-.*\.js$/,
  /^assets\/brepkit_wasm_bg-.*\.wasm$/
];

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

const failures = rows.flatMap((row) => {
  if (row.bytes <= DEFAULT_RAW_BUDGET) {
    return [];
  }
  const exception = APPROVED_LAZY_ASSETS.find(({ pattern }) =>
    pattern.test(row.file)
  );
  if (exception && row.bytes <= exception.maxBytes) {
    return [];
  }
  return [
    {
      file: row.file,
      bytes: row.bytes,
      budgetBytes: exception?.maxBytes ?? DEFAULT_RAW_BUDGET,
      reason: exception?.reason ?? 'No approved large-asset exception'
    }
  ];
});

const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
const initialAssets = Array.from(
  indexHtml.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g),
  (match) => match[1]
);
for (const file of initialAssets) {
  if (LAZY_ENTRY_PATTERNS.some((pattern) => pattern.test(file))) {
    failures.push({
      file,
      reason: 'Lazy workspace asset is referenced by the launcher HTML'
    });
  }
}

const metadata = JSON.parse(
  readFileSync(join(DIST, 'build-meta.json'), 'utf8')
);
if (
  metadata.format !== 'openzcad-build-metadata' ||
  metadata.formatVersion !== 1 ||
  !/^[0-9a-f]{40}$/i.test(metadata.commit) ||
  !/^[0-9a-f]{40}$/i.test(metadata.brepkit?.commit)
) {
  failures.push({
    file: 'build-meta.json',
    reason: 'Build provenance is missing or malformed'
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      budgets: {
        defaultRawBytes: DEFAULT_RAW_BUDGET,
        approvedLazyAssets: APPROVED_LAZY_ASSETS.map(
          ({ pattern, maxBytes, reason }) => ({
            pattern: pattern.source,
            maxBytes,
            reason
          })
        )
      },
      initialAssets,
      provenance: {
        commit: metadata.commit,
        brepkit: metadata.brepkit
      },
      rows,
      totals,
      failures
    },
    null,
    2
  )}\n`
);

if (CHECK && failures.length > 0) {
  process.exitCode = 1;
}
