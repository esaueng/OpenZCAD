/** Aggregate local H02 production-harness JSONL; never emit private model data. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function distribution(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v) || v < 0))
    throw new Error('Expected nonempty, finite, nonnegative timing samples.');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]
  };
}

function recipeUnions(stages) {
  return stages.filter(
    (s) =>
      s.stage === 'feature' &&
      stages.some(
        (child) =>
          child.stage === 'feature' && child.name.startsWith(`${s.name}: `)
      )
  );
}

export function editMetrics(edit, unionName) {
  const stages = edit.preflight.stages;
  const sum = (predicate) =>
    stages.filter(predicate).reduce((n, s) => n + s.durationMs, 0);
  // Measurement subtasks are nested inside each body row. Count outer rows
  // only; each begins at the same index as its nested `body: subtask` rows.
  const outerMeasurements = stages.filter(
    (s) =>
      s.stage === 'measurement' &&
      !stages.some(
        (outer) =>
          outer.stage === 'measurement' &&
          outer.index === s.index &&
          s.name.startsWith(`${outer.name}: `)
      )
  );
  const history = stages.filter((s) => s.stage === 'history');
  if (history.length !== 1 || !outerMeasurements.length)
    throw new Error('Missing or ambiguous first-edit stage evidence.');
  // The recipe name comes from the imported body's name. Identify its final
  // union by the construction-feature prefix, without publishing that name.
  const unions = unionName
    ? stages.filter((s) => s.stage === 'feature' && s.name === unionName)
    : recipeUnions(stages);
  if (unions.length !== 1)
    throw new Error('Expected one holder recipe union stage.');
  return {
    suffixReplayMs: history[0].durationMs,
    growingHolderUnionMs: unions[0].durationMs,
    fixedTextMs: sum((s) => s.stage === 'feature' && s.name === 'Text'),
    textPlacementMs: sum(
      (s) => s.stage === 'feature' && s.name === 'Keep text together'
    ),
    // In the staged pipeline, a body's timer stays open until deferred
    // analysis completes. Outer timers overlap too. Reconstruct the envelope
    // from log receipt time and worker duration; never sum those timers.
    bodyMeasurementEnvelopeMs:
      Math.max(...outerMeasurements.map((s) => s.t)) -
      Math.min(...outerMeasurements.map((s) => s.t - s.durationMs)),
    exactCompletionMs: edit.exactMs
  };
}

export function matchedReport(disabled, enabled) {
  if (!disabled.length || disabled.length !== enabled.length)
    throw new Error(
      'Both arms need the same nonzero number of completed pairs.'
    );
  const all = [...disabled, ...enabled];
  for (const key of [
    'sourceCommit',
    'lockfileSha256',
    'sourceSha256',
    'scenario',
    'parameter',
    'featureCount'
  ]) {
    if (!all[0][key] || all.some((s) => s[key] !== all[0][key]))
      throw new Error(`Unmatched benchmark identity: ${key}.`);
  }
  const counts = all[0].exactCounts;
  if (
    !counts ||
    !Number.isSafeInteger(counts.bodies) ||
    counts.bodies <= 0 ||
    !Number.isSafeInteger(counts.faces) ||
    counts.faces <= 0 ||
    all.some(
      (s) =>
        s.exactCounts?.bodies !== counts.bodies ||
        s.exactCounts?.faces !== counts.faces
    )
  )
    throw new Error('Missing or unmatched exact body/face counts.');
  const editSequence = (s) =>
    JSON.stringify([
      s.valueAfterReload,
      s.edits.map((e) => [e.label, e.value])
    ]);
  if (all.some((s) => editSequence(s) !== editSequence(all[0])))
    throw new Error('Unmatched parameter edit sequence.');
  const pairSet = (samples) =>
    samples.map((s) => `${s.pair}/${s.repeat}`).sort();
  if (
    all.some((s) => s.pair == null) ||
    new Set(pairSet(disabled)).size !== disabled.length ||
    JSON.stringify(pairSet(disabled)) !== JSON.stringify(pairSet(enabled))
  )
    throw new Error('Missing, duplicate, or unmatched pair IDs.');
  const baselineEdit = disabled[0].edits.find(
    (e) => e.label === 'first edit after reload'
  );
  const baselineUnions = recipeUnions(baselineEdit?.preflight.stages ?? []);
  if (baselineUnions.length !== 1)
    throw new Error('Missing disabled-arm recipe union evidence.');
  const unionName = baselineUnions[0].name;
  const summarize = (samples, mode) => {
    const metrics = [];
    const events = [];
    for (const sample of samples) {
      if (
        sample.cacheMode !== mode ||
        !sample.observedCacheModes?.length ||
        sample.observedCacheModes.some((observed) => observed !== mode)
      )
        throw new Error('Cache arm was not observed in the running build.');
      const first = sample.edits.find(
        (e) => e.label === 'first edit after reload'
      );
      if (!first?.cacheEvents?.length)
        throw new Error('Missing first-edit cache evidence.');
      if (
        mode === 'disabled' &&
        first.cacheEvents.some((e) => e.restored || e.reusedMeasurements)
      )
        throw new Error('Disabled arm reused history or measurements.');
      metrics.push(editMetrics(first, unionName));
      events.push(...first.cacheEvents);
    }
    const reasons = {};
    for (const event of events) {
      if (!event.measurementCache)
        throw new Error('Missing cache miss diagnostics.');
      for (const [reason, count] of Object.entries(
        event.measurementCache.misses
      ))
        reasons[reason] = (reasons[reason] ?? 0) + count;
    }
    const retainedHeap = samples.flatMap((s) =>
      Number.isFinite(s.workerHeap?.retainedJSHeapBytes)
        ? [s.workerHeap.retainedJSHeapBytes]
        : []
    );
    return {
      stagesMs: Object.fromEntries(
        Object.keys(metrics[0]).map((key) => [
          key,
          distribution(metrics.map((m) => m[key]))
        ])
      ),
      // Events may include both preflight and committed live publication. The
      // count and totals are explicit; they are never called a single sync.
      cacheEventCount: events.length,
      cache: {
        kinds: [...new Set(events.map((e) => e.kind))],
        replayed: distribution(events.map((e) => e.replayed)),
        restored: distribution(events.map((e) => e.restored)),
        measuredBodies: distribution(events.map((e) => e.remeasured)),
        reusedBodies: distribution(events.map((e) => e.reusedMeasurements)),
        missReasons: reasons,
        resetReasons: [
          ...new Set(events.map((e) => e.measurementCache.resetReason))
        ]
      },
      documentBytes: distribution(
        samples.flatMap((s) => s.copiesBeforeReload.map((c) => c.documentBytes))
      ),
      // Session peaks include startup/reload/warm work, not just first edit.
      peakAccountedMeasurementBytes: Math.max(
        ...samples.flatMap((s) =>
          s.cacheEvents.map((e) => e.measurementCache?.retainedBytes ?? 0)
        )
      ),
      peakAccountedCheckpointBytes: Math.max(
        ...samples.flatMap((s) =>
          s.cacheEvents.map((e) => e.checkpointMemory?.estimatedBytes ?? 0)
        )
      ),
      peakWasmCapacityBytes: Math.max(
        ...samples.flatMap((s) =>
          s.cacheEvents.map((e) => e.checkpointMemory?.linearMemoryBytes ?? 0)
        )
      ),
      retainedWorkerJSHeapBytes: retainedHeap.length
        ? distribution(retainedHeap)
        : null,
      workerHeapSamples: retainedHeap.length,
      // CDP isolate JS heap excludes WASM/GPU/other-worker/process retention.
      totalWorkerRetainedBytes: null
    };
  };
  const off = summarize(disabled, 'disabled'),
    on = summarize(enabled, 'enabled');
  if (off.stagesMs.exactCompletionMs.p95 <= 0)
    throw new Error('Baseline exact completion must be positive.');
  const p95Improvement =
    1 - on.stagesMs.exactCompletionMs.p95 / off.stagesMs.exactCompletionMs.p95;
  return {
    pairs: disabled.length,
    bodies: counts.bodies,
    faces: counts.faces,
    percentile: 'nearest rank; with three samples p95 is the maximum',
    disabled: off,
    enabled: on,
    p95Improvement,
    minimumTimingPairs: 3,
    existingCacheTimingTargetMet:
      disabled.length >= 3 &&
      on.stagesMs.exactCompletionMs.p95 <=
        off.stagesMs.exactCompletionMs.p95 * 0.8,
    // Timings cannot establish exact equivalence, lifetime safety or heap.
    proposedBranchCacheAccepted: false
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2)
    throw new Error(
      'Usage: node scripts/h02-cache-benchmark.mjs DISABLED.jsonl ENABLED.jsonl'
    );
  const samples = paths.map((path) =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
  console.log(JSON.stringify(matchedReport(...samples), null, 2));
}
