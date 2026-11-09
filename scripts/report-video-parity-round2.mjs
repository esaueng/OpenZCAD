/** Render local qualification artifacts; never publishes the supplied CAD. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const root = process.argv[2] ?? 'artifacts/video-parity-phase3-round2';
const old = 'artifacts/video-parity-phase3/post';
const read = (p) =>
  existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
const cell = (x) =>
  String(x ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
const ms = (x) => (typeof x === 'number' ? x.toFixed(1) : '—');
const link = (path, label = 'JSON') =>
  path ? `[${label}](../../${root}/${path})` : '—';
const shot = (p) =>
  p
    ? link(
        `${p.includes('matrix') ? 'matrix' : 'wiring'}/${basename(p.replaceAll('\\', '/'))}`,
        'PNG'
      )
    : '—';
const faces = (b) => b?.[0] ?? null;
function state(r) {
  if (!r) return 'uncollected';
  if (r.harnessError) return 'driver failure';
  if (r.uiGap) return 'no handle';
  const after = faces(r.committed ?? r.preview),
    before = faces(r.before);
  return `${after?.hash !== before?.hash ? 'changed' : 'unchanged'}; ${after?.faces ?? before?.faces ?? '?'} faces`;
}
const lines = [
  '# Phase 3 round 2: measured attempt ledger',
  '',
  'Read [assessment, limitations and reproduce commands](video-parity-phase3-round2.md). Round 1 used the 15-face saved part; round 2 adds the reference R1 cap rim (16 faces), shortens to z26 instead of z22, and picks the x=0 convex band and x=0/y=18 A3 edge. These are corrected geometry targets, so the latency samples are not a controlled speedup comparison. Typed/keypad times include automation and polling. Pointer-frame timing appears separately.',
  '',
  '| Input | Attempt | Round 1 result; preview / Apply ms | Round 2 result; preview / Apply ms | Preservation | Evidence |',
  '|---|---|---|---|---|---|'
];
const cases = [
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
for (const mode of ['history', 'step'])
  for (const id of cases) {
    const a = read(join(old, `${mode}-${id}.json`)),
      b = read(join(root, 'matrix', `${mode}-${id}.json`));
    lines.push(
      `| ${mode} | ${id} | ${state(a)}; ${ms(a?.previewMs)} / ${ms(a?.commitMs)} | ${state(b)}; ${ms(b?.previewMs)} / ${ms(b?.commitMs)} | cancel ${b?.cancelUnchanged ?? '—'}; Undo ${b?.undoUnchanged ?? '—'} | ${link(`matrix/${mode}-${id}.json`)} ${shot(b?.commitScreenshot ?? b?.previewScreenshot ?? b?.selectedScreenshot)} |`
    );
  }
for (const run of ['cumulative', 'finish-chain']) {
  lines.push(
    '',
    `## ${run === 'cumulative' ? 'Video order including A1' : 'Control: finishing chain without A1'}`,
    '',
    'Every refusal and preview-only attempt is cancelled before continuing. Rows after a refusal describe the surviving branch, not completion of the requested full chain. A4 uses the existing double-click five-edge tangent selection; the one-edge refusal is retained in the kernel control.',
    '',
    '| Input | Attempt | Result or exact refusal | Preview / Apply or refusal ms | Preservation | Evidence |',
    '|---|---|---|---|---|---|'
  );
  for (const mode of ['history', 'step']) {
    const x = read(join(root, 'wiring', `${mode}-${run}.json`));
    for (const r of x?.rows ?? []) {
      const g = r.after?.[0];
      const count = g?.geometry?.reduce((a, f) => {
        if (f) a[f.surfaceType] = (a[f.surfaceType] ?? 0) + 1;
        return a;
      }, {});
      const error =
        r.diagnostic?.detail ??
        r.workerErrors
          ?.flatMap((e) => [e.error, ...(e.warnings ?? [])])
          .filter(Boolean)
          .join('; ') ??
        r.refused ??
        r.harnessError;
      const result = g
        ? `${g.faces} faces; ${Object.entries(count ?? {})
            .map(([k, v]) => `${v} ${k}`)
            .join(', ')}`
        : r.previewOnly
          ? 'preview only; cancelled'
          : error || r.refused || 'uncollected';
      lines.push(
        `| ${mode} | ${r.label} ${r.value} | ${cell(result)} | ${ms(r.previewMs)} / ${ms(r.commitMs ?? r.refusalMs)} | cancel/refusal ${r.cancelUnchanged ?? r.unchanged ?? '—'}; Undo chain ${x?.undoToOriginal ?? '—'} | ${shot(r.screenshot)} ${link(`wiring/${mode}-${run}.json`)} |`
      );
    }
  }
}
lines.push(
  '',
  '## Real pointer frames',
  '',
  'Times run from the actual pointer event to the first WebGL frame after installing the matching published geometry. The first sample includes preparation; warm samples exclude it. Screenshots occur outside the timed interval. Each gesture cancels back to the original fingerprint, then a second gesture commits on pointer release and is undone. Shared-host browser measurements are not the kernel-only API durations.',
  '',
  '| Input | Edit | First frame ms | Warm median / range ms | Apply ms | Preservation | Evidence |',
  '|---|---|---|---|---|---|---|'
);
for (const mode of ['history', 'step'])
  for (const kind of ['blend', 'cylinder']) {
    const x = read(join(root, 'wiring', `${mode}-${kind}-pointer.json`));
    const warm = (x?.samples ?? [])
      .slice(1)
      .map((s) => s.pointerToFrameMs)
      .sort((a, b) => a - b);
    const median = warm.length
      ? (warm[Math.floor((warm.length - 1) / 2)] +
          warm[Math.ceil((warm.length - 1) / 2)]) /
        2
      : undefined;
    lines.push(
      `| ${mode} | ${kind} | ${ms(x?.samples?.[0]?.pointerToFrameMs)} | ${ms(median)} / ${ms(warm[0])}–${ms(warm.at(-1))} | ${ms(x?.commitMs)} | cancel ${x?.cancelUnchanged ?? '—'}, Undo ${x?.undoUnchanged ?? '—'} | ${link(`wiring/${mode}-${kind}-pointer.json`)} ${shot(x?.commitScreenshot)} |`
    );
  }
lines.push(
  '',
  '## Adapter result checks',
  '',
  'The full probe reached all 40 attempts but hit its aggregate 600-second limit at the final STEP oversize attempt. The targeted A6 recheck fixes a rim-dependent edge-order assumption; use its seven-edge rows below. Missing measurements remain uncollected. Raw export/reimport checks use a separate kernel and volumes at deflections 0.1, 0.01 and 0.001. Existing STEP validation warnings and approximate surfaces are retained.',
  '',
  '| Input | Attempt | Result / warnings | Preview / sync ms | Independent STEP volume range; validation | Discard restored |',
  '|---|---|---|---|---|---|'
);
const main = read(join(root, 'matrix', 'adapter.json'));
const a6 = read(join(root, 'matrix', 'adapter-A6.json'));
const oversize = read(join(root, 'matrix', 'adapter-oversize.json'));
for (const r0 of main?.rows ?? []) {
  const r =
    [...(a6?.rows ?? []), ...(oversize?.rows ?? [])].find(
      (q) => q.mode === r0.mode && q.label === r0.label
    ) ?? r0;
  const volumes = r.independent?.[0]?.volume ?? [];
  const validation = r.independent?.[0]?.validation;
  let parsed;
  try {
    parsed = JSON.parse(validation);
  } catch {
    parsed = validation;
  }
  const result = r.after
    ? `${r.after.faces} faces; ${JSON.stringify(r.after.surfaces)}`
    : (r.error ?? 'uncollected');
  lines.push(
    `| ${r.mode} | ${cell(r.label)} | ${cell(result)}; ${cell((r.warnings ?? []).join('; '))} | ${ms(r.previewMs)} / ${ms(r.commitMs)} | ${volumes.join(', ') || '—'}; ${cell(JSON.stringify(parsed) ?? '—')} | ${r.unchangedAfterDiscard ?? '—'} |`
  );
}
const raw = read(join(root, 'matrix', 'adapter-raw.json'));
lines.push(
  '',
  '## A0 and raw kernel controls',
  '',
  'A0 replays the saved native edge recipe and adds the R1 cap rim at adapter level; full UI authoring of A0 was not repeated. The remaining rows are diagnostic calls through legacy and direct kernel bindings, not substitutes for the app-level verdicts above.',
  '',
  `Saved recipe: ${raw?.A0?.bodies?.[0]?.faces ?? '—'} faces in ${ms(raw?.A0?.ms)} ms. R1 cap rim: ${raw?.A0Rim?.bodies?.[0]?.faces ?? '—'} faces in ${ms(raw?.A0Rim?.ms)} ms. ${link('matrix/adapter-raw.json')}`,
  '',
  '| Call | Result / exact error | ms | Source unchanged |',
  '|---|---|---|---|'
);
for (const r of raw?.raw ?? [])
  lines.push(
    `| ${cell(r.label)} | ${cell(r.error ?? `${r.result?.faces} faces; ${r.result?.surfaces?.join(', ')}; ${r.result?.validation}`)} | ${ms(r.ms)} | ${r.unchanged} |`
  );
lines.push(
  '',
  '## Cumulative selection control',
  '',
  'The five-edge A4 chain succeeds through both raw APIs. Its single-edge seed is refused by both. On the subsequent 12-edge bottom selection, both raw chamfer APIs refuse with a trimming failure. This does not establish that the app selected the same exact G1 run used by the native Remus reference regression.',
  '',
  `${link('chamfer-route.json')} ${link('finish-adapter.json')}`
);
writeFileSync(
  'docs/qa/video-parity-phase3-round2-measurements.md',
  `${lines.join('\n')}\n`
);
