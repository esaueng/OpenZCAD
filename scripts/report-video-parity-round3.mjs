/** Aggregate local performance captures; supplied CAD and traces stay ignored. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2] ?? 'artifacts/video-parity-phase3-round3';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n
    ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2
    : null;
};
const sum = (stages, names) =>
  names.reduce((n, name) => n + (stages[name]?.ms ?? 0), 0);
const rows = [];
const phases =
  process.argv.length > 3
    ? process.argv.slice(3)
    : ['before', 'final-head', 'after-untraced-rerun'];
for (const phase of phases) {
  for (const mode of ['history', 'step'])
    for (const kind of ['blend', 'cylinder']) {
      const stem = `${mode}-${kind}`;
      // Exclude the captures whose teardown overlapped another runner.
      if (phase === 'after-final' && mode !== 'history') continue;
      const path = join(root, phase, `${stem}-pointer.json`);
      if (!existsSync(path)) continue;
      const r = read(path);
      const chromePath = join(root, phase, `${stem}-chrome.json`);
      let canonicalPaintMs = null;
      if (existsSync(chromePath)) {
        const events = read(chromePath).traceEvents;
        const frames = events.filter(
          (e) =>
            e.name === 'oz:edit.frame' &&
            e.ph === 'b' &&
            JSON.parse(e.args.detail ?? '{}').analysis === 'ready'
        );
        frames.sort((a, b) => b.args.callTime - a.args.callTime);
        const frame = frames[0];
        const end =
          frame &&
          events.find(
            (e) =>
              e.name === frame.name &&
              e.ph === 'e' &&
              e.pid === frame.pid &&
              e.id2?.local === frame.id2?.local
          );
        const releases = end
          ? events
              .filter(
                (e) =>
                  e.pid === end.pid &&
                  e.name === 'EventDispatch' &&
                  e.args?.data?.type === 'pointerup' &&
                  e.ts < end.ts
              )
              .sort((a, b) => b.ts - a.ts)
          : [];
        if (end && releases.length)
          canonicalPaintMs = (end.ts - releases[0].ts) / 1000;
      }
      const workerPath = join(root, phase, `${stem}-worker.json`);
      const profiles = existsSync(workerPath) ? read(workerPath) : [];
      const previews = profiles.filter(
        (p) => p.operation === 'preview-geometry'
      );
      const warm = previews.slice(1, 5).map((p) => p.profile);
      const stage = (...names) => median(warm.map((p) => sum(p.stages, names)));
      const replies = r.trace.filter((e) => e.kind === 'reply').slice(1, 5);
      const canonicalIndex = profiles.findIndex(
        (p) => p.profile.stages['kernel.commitPreparedGroupEditJournaled']
      );
      const canonical =
        canonicalIndex < 0 ? null : profiles[canonicalIndex].profile;
      const canonicalStage = (...names) =>
        canonical ? sum(canonical.stages, names) : null;
      rows.push({
        phase,
        mode,
        kind,
        warmPointerMs: median(
          r.samples.slice(1).map((s) => s.pointerToFrameMs)
        ),
        firstPointerMs: r.samples[0].pointerToFrameMs,
        warmRangeMs: [
          Math.min(...r.samples.slice(1).map((s) => s.pointerToFrameMs)),
          Math.max(...r.samples.slice(1).map((s) => s.pointerToFrameMs))
        ],
        releaseMs: r.commitMs,
        canonicalPaintMs,
        warmWorkerMs: median(warm.map((p) => p.elapsedMs)),
        warmOtherWorkerMs: median(
          warm.map(
            (p) =>
              p.elapsedMs -
              Object.entries(p.stages)
                .filter(([name]) => name.startsWith('kernel.'))
                .reduce((total, [, s]) => total + s.ms, 0)
          )
        ),
        warmPreparedMs: stage('kernel.previewPreparedGroupEdit'),
        warmTessellationMs: stage('kernel.tessellateSolidGroupedBinary'),
        warmExtractionMs: stage('meshPositions', 'meshIndices'),
        warmProjectionMs: stage('projection'),
        warmBoundsMs: stage('refineBounds'),
        warmValidationMs: stage(
          'kernel.validateSolidRelaxed',
          'kernel.validateSolid',
          'kernel.validateSolidDetailed',
          'kernel.meshQuality'
        ),
        warmAreaMs: stage('kernel.faceArea'),
        warmClosureMs: stage('meshClosure'),
        warmRestoreMs: stage('kernel.restore'),
        warmCheckpointMs: stage('kernel.checkpoint'),
        warmSerializeMs: stage(
          'kernel.serializeSolids',
          'kernel.deserializeSolids',
          'kernel.journalSummary'
        ),
        warmCloneMs: stage('publicationClone'),
        warmPostMs: warm.some((p) => p.stages.workerPost)
          ? stage('workerPost')
          : null,
        warmQueueMs: median(replies.map((e) => e.detail?.queueMs)),
        warmTransportMs: median(
          replies.map(
            (e) =>
              e.ms -
              e.detail.kernelMs -
              e.detail.queueMs -
              (e.detail.sendMs ?? 0)
          )
        ),
        warmInstallMs: median(r.samples.slice(1).map((s) => s.installMs)),
        warmRenderMs: median(r.samples.slice(1).map((s) => s.renderMs)),
        initialPrepareMs: previews[0]
          ? sum(previews[0].profile.stages, [
              'kernel.prepareResizeBlend',
              'kernel.prepareResizeCylindricalFace'
            ])
          : null,
        canonicalWorkerMs: canonical?.elapsedMs ?? null,
        canonicalCommitMs: canonicalStage(
          'kernel.commitPreparedGroupEditJournaled'
        ),
        canonicalValidationMs: canonicalStage(
          'kernel.validateSolidDetailed',
          'kernel.validateSolid',
          'kernel.validateSolidRelaxed'
        ),
        canonicalProofMs: canonicalStage(
          'kernel.moveFacesJournaled',
          'kernel.meshQuality'
        ),
        canonicalVolumeMs: canonicalStage('kernel.volume'),
        canonicalTessellationMs: canonicalStage(
          'kernel.tessellateSolidGroupedBinary'
        ),
        idleEchoMs:
          canonicalIndex < 0
            ? null
            : (profiles[canonicalIndex + 1]?.profile.elapsedMs ?? null),
        canonicalFingerprint: r.after[0].hash,
        cancelUnchanged: r.cancelUnchanged,
        undoUnchanged: r.undoUnchanged,
        evidence: `${phase}/${stem}`
      });
    }
}
writeFileSync(join(root, 'summary.json'), JSON.stringify(rows, null, 2) + '\n');
const fmt = (x) => (typeof x === 'number' ? x.toFixed(1) : '—');
const table = [
  '| Capture | Warm pointer → paint ms | Warm worker ms | Kernel preview ms | Tessellation ms | Area ms | Install / render ms | Release → canonical paint ms | Poll-based release ms |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...rows.map(
    (r) =>
      `| ${r.phase} ${r.mode} ${r.kind} | ${fmt(r.warmPointerMs)} | ${fmt(r.warmWorkerMs)} | ${fmt(r.warmPreparedMs)} | ${fmt(r.warmTessellationMs)} | ${fmt(r.warmAreaMs)} | ${fmt(r.warmInstallMs)} / ${fmt(r.warmRenderMs)} | ${fmt(r.canonicalPaintMs)} | ${fmt(r.releaseMs)} |`
  )
];
writeFileSync(join(root, 'summary.md'), table.join('\n') + '\n');
console.log(table.join('\n'));
