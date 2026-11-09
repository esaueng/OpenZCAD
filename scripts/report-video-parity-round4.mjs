/** Local matrix summary. Supplied CAD and raw browser evidence stay ignored. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const root = process.argv[2] ?? 'artifacts/video-parity-phase3-round4';
const mode = process.env.VIDEO_PARITY_REPORT_MODE ?? 'history';
const escape = (value) =>
  String(value ?? '—')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '; ');
const ms = (value) => (Number.isFinite(value) ? value.toFixed(1) : '—');
for (const phase of process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['strict-final', 'w14-r19-control']) {
  const path = join(root, phase, `${mode}-cumulative.json`);
  if (!existsSync(path)) continue;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const lines = [
    '| Attempt | UI outcome | Health | Analytic census | Volume mm³ | Pointer → frame ms | Apply release → canonical ms | Screenshot |',
    '|---|---|---|---|---:|---:|---:|---|'
  ];
  const rows = [...data.rows];
  if (data.undoToOriginal)
    rows.push({
      label: 'A8 cancel/Undo',
      health: data.undoHealth,
      screenshot: data.undoScreenshot
    });
  for (const row of rows) {
    const h = row.health;
    const status = row.harnessError
      ? 'Not verified'
      : row.refused
        ? row.label === 'A7-D60'
          ? 'Pass rejection'
          : 'Fail'
        : row.error
          ? 'Pass rejection'
          : row.label === 'A0-rim' && !row.diagnostic
            ? 'Partial: loaded fixture'
            : row.health?.valid === false
              ? 'Partial: mesh gaps'
              : row.previewOnly
                ? 'Partial: preview'
                : 'Pass';
    const outcome = row.harnessError
      ? `Harness incomplete: ${row.harnessError}`
      : row.refused
        ? `Refused: ${row.refused}`
        : row.error
          ? `Rejected: ${row.error}`
          : row.previewOnly
            ? 'Preview/cancel only'
            : 'Accepted';
    const census = h?.census
      ? Object.entries(h.census)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')
      : '—';
    const health = h?.valid
      ? `closed / manifold / valid; ΔV=${h.relativeSpread.toExponential(1)}`
      : JSON.stringify(h?.meshClosure ?? h?.error ?? null);
    const screenshot = row.committedScreenshot ?? row.screenshot;
    lines.push(
      `| ${escape(row.label)} | ${status}: ${escape(outcome)} | ${escape(health)} | ${census} | ${h?.volume?.[0]?.value?.toFixed(6) ?? '—'} | ${ms(row.pointer?.pointerToFrameMs)} | ${ms(row.releaseToCanonicalMs)} | ${screenshot ? `[PNG](../../${root}/${phase}/${basename(screenshot)})` : '—'} |`
    );
  }
  lines.push(
    '',
    `Undo to original: ${data.undoToOriginal === true}; final health valid: ${data.undoHealth?.valid ?? 'not captured'}.`
  );
  writeFileSync(join(root, phase, 'matrix.md'), lines.join('\n') + '\n');
}
