/**
 * The STEP + geometry parity corpus.
 *
 * Once OpenCascade is deleted there is no fallback kernel, so this suite IS
 * the regression harness for STEP import/export and for modeling on imported
 * bodies. It exists while both kernels are still present precisely so the
 * baselines can be cross-checked against a second implementation.
 *
 * Every corpus file (`corpus/manifest.ts`) and every import-modeling scenario
 * (`scenarios.ts`) is measured through BOTH adapters, and the suite holds the
 * results to three independent bars:
 *
 *   1. BASELINE — each kernel still reports what it reported last time.
 *      Catches regressions in either kernel, including ones both share.
 *   2. REFERENCE — where a corpus file has a closed-form volume derived from
 *      its own construction, each kernel must match it. This is the only bar
 *      that can say which kernel is WRONG rather than merely different.
 *   3. PARITY — BrepKit and OpenCascade agree, except exactly where
 *      `corpus-pins.ts` records that they do not.
 *
 * Nothing is asserted away. Where BrepKit is worse the delta is pinned with
 * literal values on both sides, and the pin fails on repair as well as on
 * regression.
 *
 *   pnpm test:parity-corpus
 *   OPENZCAD_WRITE_PARITY_BASELINES=1 pnpm test:parity-corpus
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BrepKitKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import { OcctStepKernelAdapter } from './occt-reference/occt-step';

import {
  fnv1a,
  measureDocument,
  measureStepFile,
  type CorpusMeasurement,
  type MeasurableAdapter
} from './corpus-metrics';
import {
  KERNEL_DELTAS,
  REFERENCE_DEVIATIONS,
  findKernelDelta,
  findReferenceDeviation
} from './corpus-pins';
import { CORPUS, REPO_ROOT, type CorpusEntry } from './corpus/manifest';
import { IMPORT_MODELING_SCENARIOS } from './scenarios';

type KernelName = 'brepkit' | 'occt';
const KERNELS: KernelName[] = ['brepkit', 'occt'];

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(HERE, 'baselines');
const CORPUS_BASELINE = join(BASELINE_DIR, 'corpus.json');
const MODELING_BASELINE = join(BASELINE_DIR, 'import-modeling.json');
const WRITE_BASELINES = process.env.OPENZCAD_WRITE_PARITY_BASELINES === '1';

/** Shape of the on-disk baseline files: subject -> kernel -> measurement. */
type BaselineFile = Record<string, Partial<Record<KernelName, unknown>>>;

/**
 * Relative tolerance for cross-kernel and baseline volume comparison.
 *
 * Justified, not guessed: on this corpus every all-planar body agrees between
 * the two kernels to ~1e-9 relative, and every analytic curved primitive
 * agrees exactly. 1e-6 sits two orders above that float noise and three orders
 * below the smallest real divergence the corpus found (1.9e-5). Loosening it
 * would start hiding defects; tightening it would start pinning float noise.
 */
const VOLUME_RTOL = 1e-6;

function loadBaseline(path: string): BaselineFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
  } catch {
    return {};
  }
}

/** Canonical `bspline x4, plane x6` rendering of a surface-type histogram. */
function surfaceTypeSignature(types: Record<string, number>): string {
  const entries = Object.entries(types).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? 'none'
    : entries.map(([type, count]) => `${type} x${count}`).join(', ');
}

/**
 * Lineage names, folded once they stop being a readable list.
 *
 * A modelled body carries a handful of semantic role names — `primitive.box.
 * face.x.min` and friends — and reading them IS the point. An imported body
 * carries one CONTENT-ADDRESSED name per face and edge (K0.6): an import has no
 * feature contract to name its topology from, so the only kernel-neutral
 * identity available is the face's own exact witness, and the shipped bracket
 * sample therefore publishes 2,543 of them. Joining those would put a 50 KB
 * literal into every pin and every failure message, which is how a measurement
 * harness gets its assertions loosened.
 *
 * So above the readable threshold this folds to a count plus an FNV-1a digest,
 * exactly as the face and edge hash SETS already do. The fold is lossless for
 * comparison — two digests are equal iff the sorted name sets are identical, so
 * it still answers "do both kernels give this imported body the same identity
 * names" — and the full sorted list stays in `baselines/corpus.json` for the
 * diff to show which name moved.
 */
const READABLE_LINEAGE_NAMES = 12;

function lineageNameSignature(names: readonly string[]): string {
  if (names.length === 0) {
    return 'none';
  }
  const joined = names.join(',');
  return names.length <= READABLE_LINEAGE_NAMES
    ? joined
    : `${names.length} names · ${fnv1a(joined)}`;
}

/**
 * The flat metric map the parity bar compares. Every value is a string or a
 * number so a divergence can be written into a pin literally.
 *
 * Face and edge hash digests are in here on purpose: hashes are the identity
 * substrate stored feature references resolve against, and ADR-011 makes them
 * cross-kernel stable for analytic faces. A digest divergence therefore means
 * a saved edge pick would land differently after the kernel flip, even when
 * every count matches.
 */
export function comparableMetrics(
  measurement: CorpusMeasurement | Omit<CorpusMeasurement, 'inspect'>
): Record<string, string | number> {
  const inspect = 'inspect' in measurement ? measurement.inspect : undefined;
  const metrics: Record<string, string | number> = {
    status: measurement.status,
    warnings: JSON.stringify(measurement.warnings),
    error: measurement.error ?? '',
    bodyCount: measurement.bodyCount,
    volume: measurement.volume,
    faceCount: measurement.faceCount,
    edgeCount: measurement.edgeCount,
    seamEdgeCount: measurement.seamEdgeCount,
    surfaceTypes: surfaceTypeSignature(measurement.surfaceTypes),
    witnessedFaces: measurement.witnessedFaces,
    witnessedEdges: measurement.witnessedEdges,
    lineageNames: lineageNameSignature(measurement.lineageNames),
    faceHashDigest: measurement.faceHashDigest,
    edgeHashDigest: measurement.edgeHashDigest,
    roundTripStatus: measurement.roundTrip.status,
    roundTripSolidCount: measurement.roundTrip.exportedSolidCount ?? -1,
    roundTripVoids: String(measurement.roundTrip.exportedVoids ?? false),
    roundTripVolumeDelta: measurement.roundTrip.volumeRelativeDelta ?? -1,
    roundTripFaceCountDelta: measurement.roundTrip.faceCountDelta ?? -1
  };
  if (inspect) {
    metrics.inspect =
      'error' in inspect
        ? `error: ${inspect.error}`
        : `solid=${inspect.solid} valid=${inspect.valid}`;
  }
  return metrics;
}

/** Compared with a RELATIVE tolerance — physical quantities. */
const RELATIVE_METRICS = new Set(['volume']);
/**
 * Compared with an ABSOLUTE tolerance — already dimensionless ratios, where a
 * relative comparison of 0 against 1e-15 reads as a 100% divergence.
 */
const ABSOLUTE_METRICS = new Set(['roundTripVolumeDelta']);
const ABSOLUTE_EPSILON = 1e-9;

function metricsAgree(
  metric: string,
  left: string | number,
  right: string | number
): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    if (RELATIVE_METRICS.has(metric)) {
      return (
        Math.abs(left - right) /
          Math.max(Math.abs(left), Math.abs(right), 1e-12) <
        VOLUME_RTOL
      );
    }
    if (ABSOLUTE_METRICS.has(metric)) {
      return Math.abs(left - right) < ABSOLUTE_EPSILON;
    }
    return left === right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right || sameFailureStage(left, right);
  }
  return left === right;
}

/**
 * An error whose message the runtime could not recover, compared by the stage
 * it failed at rather than by its prose.
 *
 * OpenCascade throws a `WebAssembly.Exception`. Whether that arrives carrying
 * a readable message or stringifies to `[object WebAssembly.Exception]`
 * depends on the host runtime's wasm exception support, not on the file, the
 * geometry, or either kernel: CI reads
 * `importStep: no shapes found in STEP data` where a runtime without that
 * support reads `importStep: [object WebAssembly.Exception]` for the very same
 * refusal. Pinning the prose therefore pins the runtime.
 *
 * So when one side is opaque, assert only what is actually observable — that
 * both refused at the same stage. Two recovered messages still compare
 * exactly, so this never masks a kernel changing its mind about a file.
 */
const OPAQUE_EXCEPTION = '[object WebAssembly.Exception]';

function sameFailureStage(left: string, right: string): boolean {
  const leftOpaque = left.includes(OPAQUE_EXCEPTION);
  const rightOpaque = right.includes(OPAQUE_EXCEPTION);
  // Both opaque means both runtimes hid it; plain equality already handled it.
  if (leftOpaque === rightOpaque) {
    return false;
  }
  const [opaque, recovered] = leftOpaque ? [left, right] : [right, left];
  // Everything the opaque form still says — which stage, on which feature —
  // must match. Only the message the runtime swallowed is treated as unknown.
  const prefix = opaque.slice(0, opaque.indexOf(OPAQUE_EXCEPTION));
  return prefix.length > 0 && recovered.startsWith(prefix);
}

/**
 * Metric dependency, so the pin list stays a checklist rather than a
 * transcript.
 *
 * When one kernel refuses a file the other reads, EVERY downstream metric
 * differs — fourteen of them for a single void file. Pinning all fourteen
 * would bury the one fact a kernel engineer needs ("BrepKit cannot read
 * BREP_WITH_VOIDS") under thirteen restatements of it. So a divergence in a
 * governing metric SUBSUMES its dependants: the governing metric must be
 * pinned, and its dependants must NOT be (the suite enforces both). The full
 * per-metric detail is still recorded, in `baselines/corpus.json`.
 */
const GOVERNED_BY: ReadonlyArray<{ governor: string; dependants: string[] }> = [
  {
    governor: 'status',
    dependants: [
      'error',
      'warnings',
      'bodyCount',
      'volume',
      'faceCount',
      'edgeCount',
      'seamEdgeCount',
      'surfaceTypes',
      'witnessedFaces',
      'witnessedEdges',
      'lineageNames',
      'faceHashDigest',
      'edgeHashDigest',
      'inspect',
      'roundTripStatus',
      'roundTripSolidCount',
      'roundTripVoids',
      'roundTripVolumeDelta',
      'roundTripFaceCountDelta'
    ]
  },
  {
    governor: 'roundTripStatus',
    dependants: [
      'roundTripSolidCount',
      'roundTripVoids',
      'roundTripVolumeDelta',
      'roundTripFaceCountDelta'
    ]
  }
];

/** Metrics whose divergence is already explained by a diverging governor. */
function subsumedMetrics(
  left: Record<string, string | number>,
  right: Record<string, string | number>
): Set<string> {
  const subsumed = new Set<string>();
  for (const { governor, dependants } of GOVERNED_BY) {
    if (!metricsAgree(governor, left[governor]!, right[governor]!)) {
      for (const dependant of dependants) {
        subsumed.add(dependant);
      }
    }
  }
  return subsumed;
}

function literal(value: string | number): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/**
 * Failure text that hands the reader the exact pin to paste. A corpus whose
 * failures are hard to act on gets its assertions loosened, which is how these
 * harnesses die.
 */
function unpinnedDeltaMessage(
  subject: string,
  metric: string,
  brepkit: string | number,
  occt: string | number
): string {
  return (
    `UNPINNED KERNEL DIVERGENCE — '${subject}' metric '${metric}':\n` +
    `  brepkit: ${literal(brepkit)}\n` +
    `  occt:    ${literal(occt)}\n` +
    'If this is a known BrepKit gap, add it to KERNEL_DELTAS in ' +
    'test/parity/corpus-pins.ts with the owning plan item:\n' +
    `  {\n` +
    `    subject: '${subject}',\n` +
    `    metric: '${metric}',\n` +
    `    brepkit: ${literal(brepkit)},\n` +
    `    occt: ${literal(occt)},\n` +
    `    owner: 'K0.?',\n` +
    `    note: '...'\n` +
    `  }\n` +
    'If it is a regression, fix it instead.'
  );
}

function repairedPinMessage(
  subject: string,
  metric: string,
  value: string | number
): string {
  return (
    `PINNED DIVERGENCE IS GONE — '${subject}' metric '${metric}' now reads ` +
    `${literal(value)} in BOTH kernels. Delete its KERNEL_DELTAS entry in ` +
    'test/parity/corpus-pins.ts and rerecord baselines with ' +
    'OPENZCAD_WRITE_PARITY_BASELINES=1. A pin must not outlive its defect.'
  );
}

/**
 * Compare the two kernels on one subject and hold every difference to the pin
 * list. Failures are soft so one run reports the whole delta set rather than
 * the first entry of it.
 */
function assertPinnedParity(
  subject: string,
  brepkitMeasurement: Omit<CorpusMeasurement, 'inspect'>,
  occtMeasurement: Omit<CorpusMeasurement, 'inspect'>
): void {
  const left = comparableMetrics(brepkitMeasurement);
  const right = comparableMetrics(occtMeasurement);
  const subsumed = subsumedMetrics(left, right);

  for (const [metric, value] of Object.entries(left)) {
    const other = right[metric]!;
    const pin = findKernelDelta(subject, metric);

    if (subsumed.has(metric)) {
      expect
        .soft(
          pin,
          `REDUNDANT PIN — '${subject}' metric '${metric}' is already ` +
            'explained by a pinned governing metric (status or ' +
            'roundTripStatus). Remove it from KERNEL_DELTAS; the per-metric ' +
            'detail lives in baselines/corpus.json.'
        )
        .toBeUndefined();
      continue;
    }

    if (metricsAgree(metric, value, other)) {
      expect
        .soft(pin, repairedPinMessage(subject, metric, value))
        .toBeUndefined();
      continue;
    }

    expect
      .soft(pin, unpinnedDeltaMessage(subject, metric, value, other))
      .toBeDefined();
    if (!pin) {
      continue;
    }
    expect
      .soft(
        metricsAgree(metric, value, pin.brepkit),
        `${subject} ${metric}: BrepKit now ${literal(value)}, pinned as ` +
          `${literal(pin.brepkit)} (owner ${pin.owner})`
      )
      .toBe(true);
    expect
      .soft(
        metricsAgree(metric, other, pin.occt),
        `${subject} ${metric}: OCCT now ${literal(other)}, pinned as ` +
          `${literal(pin.occt)} (owner ${pin.owner})`
      )
      .toBe(true);
  }
}

interface Timing {
  subject: string;
  kernel: KernelName;
  ms: number;
}

describe('STEP parity corpus', () => {
  const measured: Record<string, Record<KernelName, CorpusMeasurement>> = {};
  const modeling: Record<
    string,
    Record<KernelName, Omit<CorpusMeasurement, 'inspect'>>
  > = {};
  const buildFailures = new Map<string, string>();
  const timings: Timing[] = [];

  let brepkit: BrepKitKernelAdapter;
  let occt: OcctStepKernelAdapter;

  const adapterFor = (kernel: KernelName): MeasurableAdapter =>
    kernel === 'brepkit' ? brepkit : occt;

  beforeAll(async () => {
    brepkit = new BrepKitKernelAdapter();
    occt = await OcctStepKernelAdapter.create();

    for (const entry of CORPUS) {
      const stepText = readFileSync(join(REPO_ROOT, entry.path), 'utf8');
      const perKernel = {} as Record<KernelName, CorpusMeasurement>;
      for (const kernel of KERNELS) {
        const start = performance.now();
        perKernel[kernel] = await measureStepFile(
          adapterFor(kernel),
          stepText,
          entry.id
        );
        timings.push({
          subject: entry.id,
          kernel,
          ms: Math.round(performance.now() - start)
        });
      }
      measured[entry.id] = perKernel;
    }

    for (const scenario of IMPORT_MODELING_SCENARIOS) {
      const perKernel = {} as Record<
        KernelName,
        Omit<CorpusMeasurement, 'inspect'>
      >;
      for (const kernel of KERNELS) {
        const adapter = adapterFor(kernel);
        const start = performance.now();
        try {
          const document = await scenario.build((doc) =>
            adapter.syncDocument(doc)
          );
          perKernel[kernel] = await measureDocument(
            adapter,
            document,
            scenario.key
          );
        } catch (error) {
          buildFailures.set(
            `${scenario.key}:${kernel}`,
            error instanceof Error ? error.message : String(error)
          );
        }
        timings.push({
          subject: scenario.key,
          kernel,
          ms: Math.round(performance.now() - start)
        });
      }
      modeling[scenario.key] = perKernel;
    }
  }, 900_000);

  afterAll(() => {
    mkdirSync(BASELINE_DIR, { recursive: true });
    if (WRITE_BASELINES) {
      writeFileSync(CORPUS_BASELINE, `${JSON.stringify(measured, null, 2)}\n`);
      writeFileSync(MODELING_BASELINE, `${JSON.stringify(modeling, null, 2)}\n`);
    }
    // The forks pool swallows stdout; persist the run's shape to a file so a
    // slow corpus file can be found without rerunning under a debugger.
    writeFileSync(
      join(HERE, 'last-corpus-timings.json'),
      `${JSON.stringify(
        timings.sort((a, b) => b.ms - a.ms).slice(0, 20),
        null,
        2
      )}\n`
    );
    brepkit?.dispose();
    occt?.dispose();
  });

  // -------------------------------------------------------------------------
  // Bar 1 — baselines
  // -------------------------------------------------------------------------

  describe('baselines', () => {
    for (const entry of CORPUS) {
      for (const kernel of KERNELS) {
        it(`${entry.id} still measures as recorded on ${kernel}`, () => {
          if (WRITE_BASELINES) {
            return;
          }
          const baseline = loadBaseline(CORPUS_BASELINE)[entry.id]?.[kernel];
          expect(
            baseline,
            `no ${kernel} baseline for '${entry.id}' — rerecord with ` +
              'OPENZCAD_WRITE_PARITY_BASELINES=1'
          ).toBeDefined();
          const before = comparableMetrics(baseline as CorpusMeasurement);
          const after = comparableMetrics(measured[entry.id]![kernel]);
          for (const [metric, value] of Object.entries(after)) {
            expect
              .soft(
                metricsAgree(metric, value, before[metric]!),
                `${entry.id} [${kernel}] ${metric}: ${literal(value)} vs ` +
                  `baseline ${literal(before[metric]!)}`
              )
              .toBe(true);
          }
        });
      }
    }

    for (const scenario of IMPORT_MODELING_SCENARIOS) {
      for (const kernel of KERNELS) {
        it(`${scenario.key} still measures as recorded on ${kernel}`, () => {
          if (WRITE_BASELINES) {
            return;
          }
          const failure = buildFailures.get(`${scenario.key}:${kernel}`);
          expect(
            failure,
            `'${scenario.key}' failed to build on ${kernel}: ${failure}`
          ).toBeUndefined();
          const baseline = loadBaseline(MODELING_BASELINE)[scenario.key]?.[
            kernel
          ];
          expect(
            baseline,
            `no ${kernel} baseline for '${scenario.key}' — rerecord with ` +
              'OPENZCAD_WRITE_PARITY_BASELINES=1'
          ).toBeDefined();
          const before = comparableMetrics(baseline as CorpusMeasurement);
          const after = comparableMetrics(modeling[scenario.key]![kernel]);
          for (const [metric, value] of Object.entries(after)) {
            expect
              .soft(
                metricsAgree(metric, value, before[metric]!),
                `${scenario.key} [${kernel}] ${metric}: ${literal(value)} vs ` +
                  `baseline ${literal(before[metric]!)}`
              )
              .toBe(true);
          }
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Bar 2 — the file's own arithmetic
  // -------------------------------------------------------------------------

  describe('reference volumes', () => {
    const entriesWithReference = CORPUS.filter(
      (entry): entry is CorpusEntry & { referenceVolumeMm3: number } =>
        entry.referenceVolumeMm3 !== undefined
    );

    for (const entry of entriesWithReference) {
      for (const kernel of KERNELS) {
        it(`${entry.id} reads ${entry.referenceVolumeMm3.toFixed(3)} mm3 on ${kernel}`, () => {
          const measurement = measured[entry.id]![kernel];
          const pin = findReferenceDeviation(entry.id, kernel);
          const reported: number | 'refused' | 'threw' =
            measurement.status === 'imported' ? measurement.volume : measurement.status;

          if (pin) {
            expect(
              pin.referenceMm3,
              `${entry.id}: pin's referenceMm3 does not match the manifest`
            ).toBeCloseTo(entry.referenceVolumeMm3, 6);
            if (typeof pin.reported === 'number') {
              expect(
                typeof reported,
                `${entry.id} [${kernel}] is pinned as reporting ` +
                  `${pin.reported} but now ${reported}. If the kernel was ` +
                  'fixed, delete the REFERENCE_DEVIATIONS entry.'
              ).toBe('number');
              expect(
                Math.abs((reported as number) - pin.reported) /
                  Math.max(Math.abs(pin.reported), 1e-12),
                `${entry.id} [${kernel}] volume ${reported} no longer matches ` +
                  `its pinned ${pin.reported}`
              ).toBeLessThan(VOLUME_RTOL);
            } else {
              expect(
                reported,
                `${entry.id} [${kernel}] is pinned as '${pin.reported}'`
              ).toBe(pin.reported);
            }
            return;
          }

          expect(
            measurement.status,
            `${entry.id} [${kernel}] did not import: ` +
              `${JSON.stringify(measurement.warnings)} ${measurement.error ?? ''}\n` +
              'If this refusal is expected, pin it in REFERENCE_DEVIATIONS ' +
              '(test/parity/corpus-pins.ts) with the owning plan item.'
          ).toBe('imported');
          expect(
            Math.abs(measurement.volume - entry.referenceVolumeMm3) /
              entry.referenceVolumeMm3,
            `${entry.id} [${kernel}] volume ${measurement.volume} vs the ` +
              `file's own arithmetic ${entry.referenceVolumeMm3}. This is not ` +
              'a kernel-vs-kernel difference: the file says what it contains.'
          ).toBeLessThan(VOLUME_RTOL);
        });
      }
    }

    for (const entry of CORPUS.filter((candidate) => candidate.expectNoSolids)) {
      for (const kernel of KERNELS) {
        it(`${entry.id} yields no solid on ${kernel}`, () => {
          const measurement = measured[entry.id]![kernel];
          const pin = findReferenceDeviation(entry.id, kernel);
          if (pin) {
            expect(
              pin.referenceMm3,
              `${entry.id} declares no importable solid, so its pin's ` +
                'referenceMm3 must be 0'
            ).toBe(0);
            expect(
              typeof pin.reported,
              `${entry.id} [${kernel}] is pinned as reading ${pin.reported} ` +
                'from a file with no solid; it now refuses. Delete the ' +
                'REFERENCE_DEVIATIONS entry.'
            ).toBe('number');
            expect(
              Math.abs(measurement.volume - (pin.reported as number)) /
                Math.max(Math.abs(pin.reported as number), 1e-12),
              `${entry.id} [${kernel}] now reads ${measurement.volume} from a ` +
                `file with no solid; pinned at ${pin.reported}`
            ).toBeLessThan(VOLUME_RTOL);
            return;
          }
          expect(
            measurement.status,
            `${entry.id} [${kernel}] produced a body from a file that ` +
              'declares no importable solid — the reader accepted something ' +
              `it should have refused. volume=${measurement.volume}\n` +
              'If this is a known reader gap, pin it in REFERENCE_DEVIATIONS ' +
              '(test/parity/corpus-pins.ts) with referenceMm3: 0.'
          ).not.toBe('imported');
          expect(
            measurement.warnings.length + (measurement.error ? 1 : 0),
            `${entry.id} [${kernel}] refused silently: a refusal with no ` +
              'diagnostic is indistinguishable from an empty file'
          ).toBeGreaterThan(0);
        });
      }
    }

    for (const scenario of IMPORT_MODELING_SCENARIOS) {
      for (const kernel of KERNELS) {
        it(`${scenario.key} reaches its nominal volume on ${kernel}`, () => {
          const measurement = modeling[scenario.key]?.[kernel];
          expect(
            measurement,
            `'${scenario.key}' did not build on ${kernel}: ` +
              buildFailures.get(`${scenario.key}:${kernel}`)
          ).toBeDefined();
          const pin = findReferenceDeviation(scenario.key, kernel);
          if (pin) {
            expect(typeof pin.reported === 'number').toBe(true);
            expect(
              Math.abs(measurement!.volume - (pin.reported as number)) /
                Math.max(Math.abs(pin.reported as number), 1e-12),
              `${scenario.key} [${kernel}] volume ${measurement!.volume} no ` +
                `longer matches its pinned ${pin.reported}. If the kernel was ` +
                'fixed, delete the REFERENCE_DEVIATIONS entry.'
            ).toBeLessThan(VOLUME_RTOL);
            return;
          }
          expect(
            measurement!.status,
            `${scenario.key} [${kernel}] warnings: ` +
              JSON.stringify(measurement!.warnings)
          ).toBe('imported');
          expect(measurement!.warnings, `${scenario.key} [${kernel}]`).toEqual(
            []
          );
          expect(
            Math.abs(measurement!.volume - scenario.nominalVolumeMm3) /
              scenario.nominalVolumeMm3,
            `${scenario.key} [${kernel}] volume ${measurement!.volume} vs ` +
              `nominal ${scenario.nominalVolumeMm3} (rtol ${scenario.nominalRtol})`
          ).toBeLessThan(scenario.nominalRtol);
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Bar 3 — BrepKit vs OpenCascade, pinned in both directions
  // -------------------------------------------------------------------------

  describe('kernel parity', () => {
    for (const entry of CORPUS) {
      it(`${entry.id}: BrepKit matches OCCT except where pinned`, () => {
        assertPinnedParity(
          entry.id,
          measured[entry.id]!.brepkit,
          measured[entry.id]!.occt
        );
      });
    }

    for (const scenario of IMPORT_MODELING_SCENARIOS) {
      it(`${scenario.key}: BrepKit matches OCCT except where pinned`, () => {
        const both = modeling[scenario.key]!;
        expect(
          both.brepkit && both.occt,
          `'${scenario.key}' did not build on both kernels: ` +
            `brepkit=${buildFailures.get(`${scenario.key}:brepkit`) ?? 'ok'}, ` +
            `occt=${buildFailures.get(`${scenario.key}:occt`) ?? 'ok'}`
        ).toBeTruthy();
        assertPinnedParity(scenario.key, both.brepkit, both.occt);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Pin hygiene
  // -------------------------------------------------------------------------

  describe('pin hygiene', () => {
    const subjects = new Set([
      ...CORPUS.map((entry) => entry.id),
      ...IMPORT_MODELING_SCENARIOS.map((scenario) => scenario.key)
    ]);

    it('every pin names a real subject and a real metric', () => {
      const metricNames = new Set(
        Object.keys(comparableMetrics(measured[CORPUS[0]!.id]!.brepkit))
      );
      for (const pin of KERNEL_DELTAS) {
        expect(
          subjects.has(pin.subject),
          `KERNEL_DELTAS pins unknown subject '${pin.subject}'`
        ).toBe(true);
        expect(
          metricNames.has(pin.metric),
          `KERNEL_DELTAS pins unknown metric '${pin.metric}' on '${pin.subject}'`
        ).toBe(true);
      }
      for (const pin of REFERENCE_DEVIATIONS) {
        expect(
          subjects.has(pin.subject),
          `REFERENCE_DEVIATIONS pins unknown subject '${pin.subject}'`
        ).toBe(true);
      }
    });

    it('no pin is duplicated', () => {
      const keys = KERNEL_DELTAS.map((pin) => `${pin.subject}:${pin.metric}`);
      expect(new Set(keys).size, `duplicate KERNEL_DELTAS: ${keys.join(', ')}`).toBe(
        keys.length
      );
      const referenceKeys = REFERENCE_DEVIATIONS.map(
        (pin) => `${pin.subject}:${pin.kernel}`
      );
      expect(
        new Set(referenceKeys).size,
        `duplicate REFERENCE_DEVIATIONS: ${referenceKeys.join(', ')}`
      ).toBe(referenceKeys.length);
    });

    it('every pin carries a note a kernel engineer can act on', () => {
      for (const pin of [...KERNEL_DELTAS, ...REFERENCE_DEVIATIONS]) {
        expect(
          pin.note.length,
          `${pin.subject}: a pin without a real note is a shrug, not a measurement`
        ).toBeGreaterThan(40);
      }
    });
  });
});
