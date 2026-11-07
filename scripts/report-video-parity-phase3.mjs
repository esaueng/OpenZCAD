// Compare private local evidence without copying fixtures or machine paths.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const root = process.argv[2] ?? 'artifacts/video-parity-phase3';
const old = process.argv[3] ?? 'artifacts/video-parity';
const dest = process.argv[4] ?? 'docs/qa/video-parity-phase3-comparison.md';
const read = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const esc = (s) =>
  String(s ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
const ms = (n) => (typeof n === 'number' ? n.toFixed(1) : '—');
const topology = (b) => {
  if (!b) return 'unmeasured';
  const surfaces =
    b.surfaces ??
    (b.geometry ?? []).reduce((counts, g) => {
      const type = g?.surfaceType ?? 'unknown';
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {});
  return `${b.faces} faces; ${Object.entries(surfaces)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ')}`;
};
const link = (path, label) =>
  `[${label}](${relative('docs/qa', path).replaceAll('\\', '/')})`;
const shot = (r, dir) => {
  const path =
    r?.committedScreenshot ??
    r?.commitScreenshot ??
    r?.previewScreenshot ??
    r?.selectedScreenshot ??
    r?.screenshot;
  return path ? link(join(dir, basename(path)), 'PNG') : '—';
};
const result = (r) => {
  if (!r) return 'unmeasured';
  if (r.harnessError) return 'harness error';
  if (r.uiGap) return 'no handle';
  const b = r.committed?.[0] ?? r.preview?.[0];
  const changed = b && b.hash !== r.before?.[0]?.hash;
  return `${changed ? 'changed' : 'unchanged'}${b ? `; ${b.faces} faces` : ''}`;
};
const cell = (r, dir, stem) =>
  r
    ? `${result(r)}; ${ms(r.previewMs)} / ${ms(r.commitMs)} ms; ${link(join(dir, `${stem}.json`), 'JSON')} ${shot(r, dir)}`
    : 'unmeasured';
const ids = [
  'A1-short',
  'A1-long',
  'A1-invalid',
  'A2-concave',
  'A2-convex',
  'A3',
  'A4-R1.5',
  'A4-R3.7',
  'A4-C0.7',
  'A4-C5',
  'A5-negative',
  'A6-bottom',
  'A6-chain',
  'A7-D14.6',
  'A7-D17',
  'A7-D21.1',
  'A7-D14.7',
  'A7-D60'
];
const lines = [
  '# Phase 3: before/after attempt comparison',
  '',
  'Read [scope, assessments and reproduction](video-parity-phase3.md). These are individual shared-host samples, including automation and polling; no speedup is inferred. Cells give preview / commit latency. “Unchanged” is the measured result, not a pass/fail verdict: expected invalid inputs should be unchanged. Evidence links point to ignored files in the measured worktree.',
  '',
  '| Input | Attempt | 124 baseline | 125 before app wiring | 125 with app wiring |',
  '|---|---|---|---|---|'
];
for (const mode of ['history', 'step'])
  for (const id of ids) {
    const stem = `${mode}-${id}`;
    const dirs = [old, join(root, 'pre'), join(root, 'post')];
    lines.push(
      `| ${mode} | ${id} | ${dirs.map((dir) => cell(read(join(dir, `${stem}.json`)), dir, stem)).join(' | ')} |`
    );
  }
lines.push(
  '',
  '## Explicit UI wiring qualification',
  '',
  '| Input | Attempt | Result | Preview / commit or refusal ms | Preservation | Screenshot |',
  '|---|---|---|---|---|---|'
);
for (const mode of ['history', 'step']) {
  const dir = join(root, 'post');
  const a2 = read(join(dir, `${mode}-A2-wired.json`));
  for (const r of a2?.rows ?? [])
    lines.push(
      `| ${mode} | A2 R${r.radius} | ${topology(r.after?.[0])}; ${r.previewMode} | ${ms(r.previewMs)} / ${ms(r.commitMs)} | Undo to original: ${a2.undoUnchanged} | ${shot(r, dir)} |`
    );
  for (const [id, label] of [
    ['A6-wired', 'A6 single pick → 7 edges'],
    ['A7-oversize', 'A7 oversize typed refusal']
  ]) {
    const r = read(join(dir, `${mode}-${id}.json`));
    if (r)
      lines.push(
        `| ${mode} | ${label} | ${id === 'A6-wired' ? '20 faces' : 'rejected'} | ${ms(r.previewMs)} / ${ms(r.commitMs ?? r.refusalMs)} | ${r.undoUnchanged ?? r.unchanged} | ${shot(r, dir)} |`
      );
  }
}
lines.push(
  '',
  '## Cumulative workflow',
  '',
  'Refused steps are cancelled before proceeding. Therefore rows after a refusal are a surviving branch, not proof that the full reference sequence completed.',
  '',
  '| Input | Attempt | Result | Preview / commit or refusal ms | Preservation | Evidence |',
  '|---|---|---|---|---|---|'
);
for (const mode of ['history', 'step']) {
  const dir = join(root, 'post');
  const data = read(join(dir, `${mode}-cumulative.json`));
  for (const r of data?.rows ?? []) {
    const refusal = r.refused
      ? [r.diagnostic?.message ?? r.refused, r.diagnostic?.detail]
          .filter(Boolean)
          .join('\n')
      : null;
    lines.push(
      `| ${mode} | ${r.label} ${r.value} | ${esc(r.harnessError ?? refusal ?? `changed; ${topology(r.after?.[0])}`)} | ${ms(r.previewMs)} / ${ms(r.commitMs ?? r.refusalMs)}${r.previewMode ? `; ${r.previewMode}` : ''} | ${r.cancelUnchanged ?? r.unchanged ?? 'unverified'} | ${shot(r, dir)} ${link(join(dir, `${mode}-cumulative.json`), 'JSON')} |`
    );
  }
  lines.push(
    `| ${mode} | Final Undo | original restored: ${data?.undoToOriginal ?? 'unverified'} | — | ${data?.undoToOriginal ?? 'unverified'} | ${link(join(dir, `${mode}-cumulative.json`), 'JSON')} |`
  );
}
writeFileSync(dest, `${lines.join('\n')}\n`);
