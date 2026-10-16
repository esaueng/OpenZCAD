import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  distribution,
  editMetrics,
  matchedReport
} from './h02-cache-benchmark.mjs';

function sample(mode, pair, exactMs) {
  const stages = [
    { stage: 'history', name: 'Building history', durationMs: 40 },
    { stage: 'feature', name: 'Growing holder', durationMs: 30 },
    { stage: 'feature', name: 'Growing holder: bridge', durationMs: 5 },
    { stage: 'feature', name: 'Keep text together', durationMs: 2 },
    {
      stage: 'measurement',
      name: 'Body: named',
      index: 1,
      t: 100,
      durationMs: 20
    },
    {
      stage: 'measurement',
      name: 'Body: named: proofs',
      index: 1,
      durationMs: 15
    }
  ];
  const cache = {
    kind: mode === 'disabled' ? 'full-rebuild' : 'prefix-restore',
    replayed: 15,
    restored: mode === 'disabled' ? 0 : 16,
    remeasured: 9,
    reusedMeasurements: mode === 'disabled' ? 0 : 8,
    measurementCache: {
      misses: { 'solid-handles': 9 },
      retainedBytes: 100,
      resetReason: null
    }
  };
  return {
    sourceCommit: 'commit',
    lockfileSha256: 'lock',
    sourceSha256: 'source',
    scenario: 'private holder',
    parameter: 'holder_height',
    featureCount: 31,
    exactCounts: { bodies: 8, faces: 48 },
    pair,
    repeat: 0,
    cacheMode: mode,
    observedCacheModes: [mode],
    copiesBeforeReload: [{ documentBytes: 1000 }],
    cacheEvents: [cache],
    edits: [
      {
        label: 'first edit after reload',
        exactMs,
        preflight: { stages },
        cacheEvents: [cache]
      }
    ]
  };
}

test('nearest-rank p95 keeps slow samples and uses a true even-sample median', () => {
  assert.deepEqual(distribution([1, 2, 100]), { n: 3, median: 2, p95: 100 });
  assert.equal(distribution([1, 2, 4, 100]).median, 3);
  assert.throws(() => distribution([NaN]));
});
test('does not double-count union or nested measurement stages', () => {
  assert.deepEqual(editMetrics(sample('enabled', '1', 70).edits[0]), {
    suffixReplayMs: 40,
    growingHolderUnionMs: 30,
    fixedTextMs: 0,
    textPlacementMs: 2,
    bodyMeasurementEnvelopeMs: 20,
    exactCompletionMs: 70
  });
});
test('separates timing threshold from branch-cache acceptance', () => {
  const report = matchedReport(
    ['1', '2', '3'].map((pair) => sample('disabled', pair, 100)),
    ['1', '2', '3'].map((pair) => sample('enabled', pair, 70))
  );
  assert.equal(report.existingCacheTimingTargetMet, true);
  assert.equal(report.proposedBranchCacheAccepted, false);
  assert.equal(report.enabled.totalWorkerRetainedBytes, null);
});
test('rejects unmatched fixtures, missing arms, duplicate pairs and inactive cache seam', () => {
  const off = sample('disabled', '1', 100),
    on = sample('enabled', '1', 70);
  assert.throws(() => matchedReport([off], []));
  assert.throws(() => matchedReport([off], [{ ...on, sourceSha256: 'other' }]));
  assert.throws(() => matchedReport([off, off], [on, on]));
  assert.throws(() =>
    matchedReport([off], [{ ...on, observedCacheModes: [] }])
  );
  const falseOff = structuredClone(off);
  falseOff.edits[0].cacheEvents[0].restored = 1;
  assert.throws(() => matchedReport([falseOff], [on]));
});

test('overlapping outer body timers use an envelope rather than a sum', () => {
  const edit = sample('enabled', '1', 70).edits[0];
  edit.preflight.stages.push({
    stage: 'measurement',
    name: 'Second',
    index: 2,
    t: 110,
    durationMs: 20
  });
  assert.equal(editMetrics(edit).bodyMeasurementEnvelopeMs, 30);
});

test('exactly twenty percent meets the timing threshold', () => {
  const report = matchedReport(
    ['1', '2', '3'].map((pair) => sample('disabled', pair, 100)),
    ['1', '2', '3'].map((pair) => sample('enabled', pair, 80))
  );
  assert.equal(report.existingCacheTimingTargetMet, true);
});

test('rejects a zero baseline rather than claiming an undefined percentage', () => {
  assert.throws(() =>
    matchedReport([sample('disabled', '1', 0)], [sample('enabled', '1', 0)])
  );
});

test('identifies the same union when a cache hit replays no construction features', () => {
  const off = sample('disabled', '1', 100),
    on = sample('enabled', '1', 70);
  on.edits[0].preflight.stages = on.edits[0].preflight.stages.filter(
    (s) => s.name !== 'Growing holder: bridge'
  );
  assert.equal(
    matchedReport([off], [on]).enabled.stagesMs.growingHolderUnionMs.median,
    30
  );
});

test('rejects missing or changed exact body/face counts', () => {
  const off = sample('disabled', '1', 100),
    on = sample('enabled', '1', 70);
  assert.throws(() => matchedReport([off], [{ ...on, exactCounts: null }]));
  assert.throws(() =>
    matchedReport([off], [{ ...on, exactCounts: { bodies: 8, faces: 49 } }])
  );
});

test('a one-pair smoke run cannot meet the timing acceptance target', () => {
  assert.equal(
    matchedReport([sample('disabled', '1', 100)], [sample('enabled', '1', 1)])
      .existingCacheTimingTargetMet,
    false
  );
});
