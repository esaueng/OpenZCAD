// Generates a local baseline report from the opt-in fixture probes; no model bytes.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = process.argv[2] ?? 'artifacts/video-parity';
const dest = process.argv[3] ?? 'docs/qa/video-parity-measurements.md';
const scope = process.argv[4] ?? 'video-parity-baseline.md';
const report = JSON.parse(readFileSync(join(root, 'adapter.json'), 'utf8'));
const esc = (s) =>
  String(s ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
const ms = (n) => (typeof n === 'number' ? n.toFixed(1) : '—');
const body = (b) =>
  b
    ? `${b.faces} faces; ${Object.entries(b.surfaces ?? {})
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}`
    : '—';
const link = (path, label) =>
  `[${label}](${relative('docs/qa', path).replaceAll('\\', '/')})`;
const cleanPath = (p) => join(root, String(p).split(/[\\/]/).at(-1));
const screenshotFor = (r) => {
  const label = r.label;
  let id;
  if (label.startsWith('A1'))
    id = label.endsWith('-14')
      ? 'A1-short'
      : label.endsWith('25.2')
        ? 'A1-long'
        : 'A1-invalid';
  else if (label.startsWith('A2'))
    id = label.includes('convex') ? 'A2-convex' : 'A2-concave';
  else if (label.startsWith('A3')) id = 'A3';
  else if (label.startsWith('A4'))
    id = label.includes('fillet')
      ? `A4-R${label.split(' ').at(-1)}`
      : `A4-C${Number(label.split(' ').at(-1))}`;
  else if (label.startsWith('A5')) id = 'A5-negative';
  else if (label.startsWith('A6'))
    id = label.includes('tangent') ? 'A6-chain' : 'A6-bottom';
  else if (label.startsWith('A7')) id = `A7-D${label.split(' ').at(-1)}`;
  if (!id) return '—';
  const stem = join(root, `${r.mode}-${id}`);
  const path = existsSync(`${stem}-preview.png`)
    ? `${stem}-preview.png`
    : `${stem}-selected.png`;
  return existsSync(path)
    ? link(path, label.startsWith('A2') ? 'band-class UI PNG' : 'UI PNG')
    : '—';
};
let lines = [
  '# Supplied direct-edit workflow: measured attempts',
  '',
  `Generated from the local evidence. Read [scope and reproduction](${scope}) before interpreting passes. Times are single samples on a shared Windows host, not a performance guarantee. Preview and full adapter sync are different measurements. Browser times include automation and polling.`,
  '',
  '## Adapter attempts',
  '',
  '| Input | Attempt | Result | Preview / sync ms | Result topology | Discard restored source | Exact diagnostic | Evidence | Screenshot |',
  '|---|---|---|---:|---|---|---|---|---|'
];
lines.splice(
  4,
  0,
  '## A0 reconstruction',
  '',
  `The supplied unfilleted native body has ${report.A0?.before?.[0]?.faces} faces. Replaying its saved five-edge R4 recipe takes ${ms(report.A0?.ms)} ms and produces ${body(report.A0?.bodies?.[0])}. ${esc(report.A0?.warnings?.join('\n'))}`,
  '',
  `Supplementary cap-rim R1: ${ms(report.A0Rim?.ms)} ms; ${body(report.A0Rim?.bodies?.[0])}. This is an adapter-only supplemental variant; it does not change the W-Fillet starting fixture.`,
  ''
);
for (const r of report.rows) {
  const unchanged = r.before?.geometryHash === r.after?.geometryHash;
  const warnings = (r.warnings ?? []).filter(
    (w) => !w.startsWith('Feature "Fillet":')
  );
  const result = unchanged
    ? 'Rejected / unchanged'
    : r.after
      ? 'Changed'
      : 'Error';
  lines.push(
    `| ${r.mode} | ${esc(r.label)} | ${result} | ${ms(r.previewMs)} / ${ms(r.commitMs)} | ${body(r.after)} | ${r.unchangedAfterDiscard ? 'yes' : 'unverified'} | ${esc(r.error ?? warnings.join('\n'))} | ${link(join(root, 'adapter.json'), 'JSON')} | ${screenshotFor(r)} |`
  );
}
if (existsSync(join(root, 'native-source.json'))) {
  const native = JSON.parse(
    readFileSync(join(root, 'native-source.json'), 'utf8')
  );
  lines.push(
    '',
    '## Native source-parameter replay',
    '',
    'This is the app ancestry route, separate from the local direct edits above. Failed rebuild candidates are not committed by the UI.',
    '',
    '| Dimension / target | Sync ms | Verdict | Result | Exact diagnostic |',
    '|---|---:|---|---|---|'
  );
  for (const r of native)
    lines.push(
      `| ${r.dimension} ${r.value} | ${ms(r.ms)} | ${r.failed ? 'Rejected candidate' : 'Replayed'} | ${r.bodies.map((b) => `${b.faces} faces; volume ${b.volume}`).join('; ')} | ${esc(r.warnings.join('\n'))} |`
    );
  lines.push(
    '',
    link(
      join(root, 'native-source.json'),
      'Native raw evidence with radii, mesh closure and three-deflection validation'
    ),
    ''
  );
}
lines.push(
  '',
  '## Browser attempts',
  '',
  'An “ok” Playwright test means its evidence collection completed, including observed refusals. It does not mean the modeling acceptance step passed. Empty operation times mean that the UI exposed no editable handle or refused before Apply.',
  '',
  '| Input | Attempt | Selection / handle | Preview / Apply ms | Cancel / Undo restores | UI outcome | Screenshot | JSON |',
  '|---|---|---|---:|---|---|---|---|'
);
for (const f of readdirSync(root)
  .filter((f) => /^(history|step)-.*\.json$/.test(f))
  .sort()) {
  const r = JSON.parse(readFileSync(join(root, f), 'utf8'));
  // Phase 3 also keeps wiring journals and runtime identities in this folder.
  if (!r.mode || !r.id) continue;
  const path = r.previewScreenshot ?? r.selectedScreenshot ?? r.errorScreenshot;
  lines.push(
    `| ${r.mode} | ${esc(r.id)} | ${esc(r.selectionText)}; ${esc(r.tool)} | ${ms(r.previewMs)} / ${ms(r.commitMs)} | ${r.cancelUnchanged ? 'yes' : 'unverified'} / ${r.undoUnchanged ? 'yes' : '—'} | ${esc(r.harnessError ?? r.uiGap ?? r.commitStatus ?? r.previewText)} | ${path ? link(cleanPath(path), 'PNG') : '—'} | ${link(join(root, f), 'JSON')} |`
  );
}
lines.push(
  '',
  '## Geometry checks',
  '',
  'Export/reimport uses a separate kernel arena and STEP translator, not an independent geometry implementation. Volume was measured at deflections 0.1, 0.01, and 0.001 mm. Mesh closure uses the existing welded-edge inspector on the app projection; its limits are described in `imported-step-validation.ts`.',
  '',
  '| Input / attempt | Mesh boundary / nonmanifold / winding edges | Exported volume range mm³ | B-rep validation |',
  '|---|---:|---:|---|'
);
for (const r of report.rows) {
  const mesh = r.after?.meshClosure;
  const independent = r.independent?.[0];
  const v = independent?.volume ?? [];
  lines.push(
    `| ${r.mode} / ${esc(r.label)} | ${mesh ? `${mesh.boundaryEdges} / ${mesh.nonManifoldEdges} / ${mesh.inconsistentWindingEdges}` : '—'} | ${v.length ? `${Math.min(...v).toFixed(9)} – ${Math.max(...v).toFixed(9)}` : '—'} | ${esc(independent?.validation)} |`
  );
}
lines.push(
  '',
  '## Raw kernel controls',
  '',
  'These controls retain exact kernel refusal text and check that serialization of the source solid stays byte-identical. A radial `moveFaces` call is a control only; the app uses `resizeCylindricalFace`.',
  '',
  '| Attempt | Kernel ms | Result / exact error | Source unchanged |',
  '|---|---:|---|---|'
);
for (const r of report.raw ?? [])
  lines.push(
    `| ${esc(r.label)} | ${ms(r.ms)} | ${esc(r.error ?? `${r.result?.faces} faces; ${r.result?.validation}`)} | ${r.unchanged ? 'yes' : 'no'} |`
  );
for (const [file, title] of [
  ['A7-sequence.json', 'Native sequential diameters'],
  ['A8-drag.json', 'Pointer drag and cancel']
]) {
  if (existsSync(join(root, file)))
    lines.push(
      '',
      `## ${title}`,
      '',
      link(join(root, file), 'Raw per-attempt timing and state evidence')
    );
}
if (existsSync(join(root, 'pinned', 'adapter.json'))) {
  const pinned = JSON.parse(
    readFileSync(join(root, 'pinned', 'adapter.json'), 'utf8')
  );
  let equal = 0,
    total = 0;
  for (const r of report.rows) {
    const p = pinned.rows.find((x) => x.mode === r.mode && x.label === r.label);
    if (!p) continue;
    total++;
    const verdict = (x) => ({
      changed: x.before?.geometryHash !== x.after?.geometryHash,
      faces: x.after?.faces,
      surfaces: x.after?.surfaces,
      refused: (x.warnings ?? []).some(
        (w) =>
          !w.startsWith('Feature "Fillet":') &&
          !w.includes('This fillet is approximate')
      )
    });
    if (JSON.stringify(verdict(r)) === JSON.stringify(verdict(p))) equal++;
  }
  lines.push(
    '',
    '## Pinned adapter control',
    '',
    `${equal}/${total} matched attempts have the same changed/refused verdict and result face/surface census. This compares capabilities, not latency or the full pinned-kernel UI. ${link(join(root, 'pinned', 'adapter.json'), 'Pinned raw evidence')}.`
  );
}
writeFileSync(dest, lines.join('\n') + '\n');
console.log(`Wrote ${dest}`);
