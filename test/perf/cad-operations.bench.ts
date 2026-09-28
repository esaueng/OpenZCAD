// Opt-in, serial CAD rebuild characterization. This records observations; it
// deliberately has no wall-clock acceptance thresholds.
import { it, expect } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  extrudeSketch,
  filletEdges,
  getLatestBodyId,
  getLatestSketchId,
  listFeaturesInOrder,
  patternBody,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  toUserId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import { createExactKernelAdapter as create } from '@openzcad/kernel-adapter/exact';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { RebuildCacheEvent } from '../../packages/kernel-adapter/src/exact';

type Family =
  | 'extrude'
  | 'boolean'
  | 'fillet'
  | 'chamfer'
  | 'pattern'
  | 'parameter'
  | 'direct-edit';

interface Fixture {
  document: ProjectDocument;
  featureIndex: number;
  editOperation(document: ProjectDocument): ProjectDocument;
  editEarly(document: ProjectDocument): ProjectDocument;
  editLate(document: ProjectDocument): ProjectDocument;
}

const userId = toUserId('cad_performance');
const familyNames: Family[] = [
  'extrude',
  'boolean',
  'fillet',
  'chamfer',
  'pattern',
  'parameter',
  'direct-edit'
];
const families = (process.env.CAD_PERF_FAMILIES ?? familyNames.join(','))
  .split(',')
  .map((value) => value.trim())
  .filter((value): value is Family => familyNames.includes(value as Family));
const counts = (process.env.CAD_PERF_HISTORY ?? '30,33,100')
  .split(',')
  .map(Number)
  .filter((value) => Number.isSafeInteger(value) && value >= 6);
const samples = Math.max(1, Number(process.env.CAD_PERF_SAMPLES ?? 5));
const output = resolve(process.env.CAD_PERF_OUT ?? 'artifacts/cad-operations');
const session = process.env.CAD_PERF_SESSION ?? 'candidate';

function firstDifference(
  left: unknown,
  right: unknown,
  path = '$'
): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length)
      return `${path}.length (${left.length} vs ${right.length})`;
    for (let index = 0; index < left.length; index += 1) {
      const found = firstDifference(
        left[index],
        right[index],
        `${path}[${index}]`
      );
      if (found) return found;
    }
    return undefined;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!(key in a) || !(key in b))
        return `${path}.${key} (missing on one side)`;
      const found = firstDifference(a[key], b[key], `${path}.${key}`);
      if (found) return found;
    }
    return undefined;
  }
  return `${path} (${JSON.stringify(left)} vs ${JSON.stringify(right)})`;
}

function normalized(state: DerivedState) {
  const { updatedAt: _updatedAt, ...derived } = state;
  const serializable = {
    ...derived,
    bodyRepresentations: Object.fromEntries(
      Object.entries(derived.bodyRepresentations).map(([id, body]) => [
        id,
        {
          ...body,
          mesh: {
            kind: body.mesh.kind,
            triangles: body.mesh.indices.length / 3
          }
        }
      ])
    )
  };
  // Remus kernel handles are rebuild-local; this one diagnostic label is
  // explicitly not persistent topology identity. Keep face count and all
  // measured geometry/topology so the oracle still catches shape drift.
  return JSON.parse(
    JSON.stringify(serializable, (key, value: unknown) =>
      key === 'blendRegionKey' ? undefined : value
    )
  ) as typeof serializable;
}

function featureAt(document: ProjectDocument, index: number) {
  const id = document.featureOrder[index];
  const feature = listFeaturesInOrder(document).find(
    (item) => item.featureId === id
  );
  if (!feature) throw new Error(`Missing feature at index ${index}.`);
  return feature;
}

function updatePrimitive(
  document: ProjectDocument,
  index: number,
  width: number
) {
  const feature = featureAt(document, index);
  if (feature.data.featureKind !== 'primitive')
    throw new Error(`Expected primitive at feature ${index}.`);
  return updateFeature(document, {
    featureId: feature.featureId,
    data: { dimensions: { width, height: 10, depth: 10 } }
  });
}

function lastPrimitiveIndex(document: ProjectDocument) {
  for (let index = document.featureOrder.length - 1; index >= 0; index -= 1) {
    if (featureAt(document, index).data.featureKind === 'primitive')
      return index;
  }
  throw new Error('Fixture contains no primitive to edit.');
}

async function fixtureFor(
  family: Family,
  adapter: ExactKernelAdapter,
  count: number
): Promise<Fixture> {
  let document = createProjectDocument(`CAD perf ${family}`, userId);
  const primitive = (name: string, width = 20) => {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width, height: 20, depth: 10 }
    });
    return getLatestBodyId(document)!;
  };
  const padBeforeEnd = (reservedFeatures: number) => {
    while (document.featureOrder.length < count - reservedFeatures) {
      primitive(`Replay filler ${document.featureOrder.length}`, 10);
    }
  };

  // Independent bodies at the beginning let the early and late edit probes
  // invalidate history without changing a CAD operation's selected topology.
  primitive('Replay prelude A', 10);
  primitive('Replay prelude B', 10);

  if (family === 'parameter') {
    document = setParameter(document, {
      name: 'plate_width',
      expression: '20'
    });
    primitive('Parameterized plate');
    while (document.featureOrder.length < count)
      primitive(`Replay filler ${document.featureOrder.length}`, 10);
    if (document.featureOrder.length !== count)
      throw new Error(
        `Fixture has ${document.featureOrder.length} features; requested ${count}.`
      );
    const featureIndex = 2;
    return {
      document: updateFeature(document, {
        featureId: featureAt(document, featureIndex).featureId,
        data: { dimensions: { width: 'plate_width' } }
      }),
      featureIndex,
      editOperation: (next) =>
        setParameter(next, { name: 'plate_width', expression: '21' }),
      editEarly: (next) => updatePrimitive(next, 0, 11),
      editLate: (next) => updatePrimitive(next, lastPrimitiveIndex(next), 11)
    };
  }

  let operationFeatureIndex = 0;
  let editOperation: Fixture['editOperation'];
  if (family === 'extrude') {
    primitive('Base');
    const sketch = addSketchFeature(document, {
      name: 'Extrude profile',
      plane: 'XY',
      offset: 10,
      object: {
        objectKind: 'rectangle',
        width: 6,
        height: 6,
        centerX: 0,
        centerY: 0
      }
    });
    document = sketch.document;
    padBeforeEnd(1);
    const result = extrudeSketch(document, {
      name: 'Extrusion',
      sketchId: getLatestSketchId(document)!,
      distance: 5
    });
    document = result.document;
    operationFeatureIndex = document.featureOrder.length - 1;
    editOperation = (next) =>
      updateFeature(next, {
        featureId: featureAt(next, operationFeatureIndex).featureId,
        data: { distance: 5.25 }
      });
  } else if (family === 'boolean') {
    const left = primitive('Boolean target', 20);
    const right = primitive('Boolean tool', 12);
    document = transformBody(document, {
      name: 'Position boolean tool',
      targetBodyId: right,
      translation: { x: 10, y: 0, z: 0 }
    }).document;
    padBeforeEnd(1);
    const result = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [left, right]
    });
    document = result.document;
    operationFeatureIndex = document.featureOrder.length - 1;
    editOperation = (next) =>
      updateFeature(next, {
        featureId: featureAt(next, operationFeatureIndex).featureId,
        data: { operation: 'subtract' }
      });
  } else if (family === 'fillet' || family === 'chamfer') {
    const bodyId = primitive('Blend source');
    const base = await adapter.syncDocument(document);
    const edge = base.bodyRepresentations[bodyId]?.topology?.edges.find(
      (candidate) => candidate.displayRole !== 'seam'
    );
    if (!edge) throw new Error(`No exact edge found for ${family} fixture.`);
    padBeforeEnd(1);
    const result =
      family === 'fillet'
        ? filletEdges(document, {
            name: 'Fillet',
            targetBodyId: bodyId,
            edgeHashes: [edge.hash],
            size: 0.5
          })
        : chamferEdges(document, {
            name: 'Chamfer',
            targetBodyId: bodyId,
            edgeHashes: [edge.hash],
            size: 0.5
          });
    document = result.document;
    operationFeatureIndex = document.featureOrder.length - 1;
    editOperation = (next) =>
      updateFeature(next, {
        featureId: featureAt(next, operationFeatureIndex).featureId,
        data: family === 'fillet' ? { radius: 0.6 } : { distance: 0.6 }
      });
  } else if (family === 'pattern') {
    const bodyId = primitive('Pattern source', 4);
    padBeforeEnd(1);
    const result = patternBody(document, {
      name: 'Linear pattern',
      targetBodyId: bodyId,
      patternKind: 'linear',
      count: 4,
      axis: 'x',
      spacing: 8
    });
    document = result.document;
    operationFeatureIndex = document.featureOrder.length - 1;
    editOperation = (next) =>
      updateFeature(next, {
        featureId: featureAt(next, operationFeatureIndex).featureId,
        data: { count: 5 }
      });
  } else {
    const bodyId = primitive('Direct edit source', 20);
    const base = await adapter.syncDocument(document);
    const face = base.bodyRepresentations[bodyId]?.topology?.faces.find(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.z ?? 0) > 0.9
    );
    if (!face?.geometry?.normal || !face.geometry.center)
      throw new Error('No planar top face found for direct-edit fixture.');
    padBeforeEnd(1);
    const result = directEditBody(document, {
      name: 'Offset top face',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: face.hash,
        faceReference: face.reference,
        sourceSurfaceType: 'plane',
        sourceArea: face.geometry.area,
        sourceCenter: face.geometry.center,
        sourceNormal: face.geometry.normal,
        offset: 1
      }
    });
    document = result.document;
    operationFeatureIndex = document.featureOrder.length - 1;
    editOperation = (next) => {
      const op = featureAt(next, operationFeatureIndex);
      if (
        op.data.featureKind !== 'direct-edit' ||
        op.data.operation.kind !== 'offset-face'
      )
        throw new Error('Direct-edit fixture changed shape.');
      return updateFeature(next, {
        featureId: op.featureId,
        data: { operation: { ...op.data.operation, offset: 1.25 } }
      });
    };
  }

  if (document.featureOrder.length !== count)
    throw new Error(
      `Fixture has ${document.featureOrder.length} features; requested ${count}.`
    );
  return {
    document,
    featureIndex: operationFeatureIndex,
    editOperation,
    editEarly: (next) => updatePrimitive(next, 0, 11),
    editLate: (next) => updatePrimitive(next, lastPrimitiveIndex(next), 11)
  };
}

function identity() {
  const require = createRequire(
    resolve('packages/kernel-adapter/package.json')
  );
  const wasmPath = require.resolve('remus-wasm/remus_wasm_bg.wasm');
  const lock = readFileSync('pnpm-lock.yaml', 'utf8');
  const remusLockLine = lock
    .split('\n')
    .find((line) => line.includes('remus-wasm@https:'));
  const sourceRoot =
    process.env.CAD_PERF_MODE === 'baseline'
      ? (process.env.CAD_PERF_BASELINE_ROOT ?? process.cwd())
      : process.cwd();
  const gitEntry = join(sourceRoot, '.git');
  const gitDir = statSync(gitEntry).isDirectory()
    ? gitEntry
    : resolve(
        sourceRoot,
        readFileSync(gitEntry, 'utf8')
          .trim()
          .replace(/^gitdir:\s*/, '')
      );
  const commonDirFile = join(gitDir, 'commondir');
  const commonDir = existsSync(commonDirFile)
    ? resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim())
    : gitDir;
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  let sourceSha = head;
  if (head.startsWith('ref: ')) {
    const ref = head.slice('ref: '.length);
    const looseRef = join(commonDir, ref);
    if (existsSync(looseRef)) sourceSha = readFileSync(looseRef, 'utf8').trim();
    else {
      const packed = readFileSync(join(commonDir, 'packed-refs'), 'utf8');
      sourceSha =
        packed
          .split('\n')
          .find((line) => line.endsWith(` ${ref}`))
          ?.split(' ')[0] ?? 'unknown';
    }
  }
  const adapterSourceDir = join(sourceRoot, 'packages/kernel-adapter/src');
  const adapterSources = readdirSync(adapterSourceDir)
    .filter((name) => name.endsWith('.ts'))
    .sort();
  const adapterSourceHash = createHash('sha256');
  for (const name of adapterSources) {
    adapterSourceHash.update(name);
    adapterSourceHash.update(readFileSync(join(adapterSourceDir, name)));
  }
  return {
    sourceSha,
    adapterSourceSha256: adapterSourceHash.digest('hex'),
    wasmSha256: createHash('sha256')
      .update(readFileSync(wasmPath))
      .digest('hex'),
    wasmBytes: readFileSync(wasmPath).byteLength,
    remusLockLine,
    node: process.version,
    platform: process.platform,
    arch: process.arch
  };
}

function percentile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0
  );
}

it('records representative CAD operation rebuild timings', async () => {
  if (!process.env.CAD_PERF_RUN) return;
  mkdirSync(output, { recursive: true });
  const provenance = identity();
  const rawPath = resolve(output, `${session}.jsonl`);
  const summaries: unknown[] = [];
  for (const family of families) {
    for (const count of counts) {
      let cache: RebuildCacheEvent | undefined;
      const setupAdapter = await create();
      let fixture: Fixture;
      try {
        fixture = await fixtureFor(family, setupAdapter, count);
      } finally {
        setupAdapter.dispose();
      }
      const full = fixture;
      const measuredAdapter = await create({
        onRebuildCacheEvent: (event) => {
          cache = event;
        }
      });
      try {
        let previous: DerivedState | undefined;
        const run = async (
          phase: string,
          sample: number,
          document: ProjectDocument
        ) => {
          const progress: unknown[] = [];
          cache = undefined;
          const start = performance.now();
          let state: DerivedState;
          try {
            state = await measuredAdapter.syncDocument(document, (event) =>
              progress.push(event)
            );
          } catch (error) {
            appendFileSync(
              rawPath,
              JSON.stringify({
                provenance,
                session,
                family,
                historyFeatures: count,
                phase,
                sample,
                status: 'error',
                elapsedMs: performance.now() - start,
                error: error instanceof Error ? error.message : String(error),
                cache,
                progress
              }) + '\n'
            );
            throw error;
          }
          const elapsedMs = performance.now() - start;
          previous = state;
          const row = {
            provenance,
            session,
            family,
            historyFeatures: count,
            phase,
            sample,
            elapsedMs,
            cache,
            progress,
            bodies: Object.keys(state.bodyRepresentations).length,
            triangles: Object.values(state.bodyRepresentations).reduce(
              (total, body) => total + body.mesh.indices.length / 3,
              0
            ),
            warnings: state.warnings,
            memory: process.memoryUsage(),
            wasmMemoryBytes: (
              globalThis as { historyWasmMemories?: WebAssembly.Memory[] }
            ).historyWasmMemories?.map((memory) => memory.buffer.byteLength)
          };
          appendFileSync(rawPath, JSON.stringify(row) + '\n');
          expect(
            state.warnings,
            `${family}/${count}/${phase}: warnings are refusals/regressions`
          ).toEqual([]);
          return { state, elapsedMs, row };
        };

        await run('cold', 0, full.document);
        await run('warm-repeat', 0, full.document);
        for (const edit of ['operation', 'early', 'late'] as const) {
          const edited =
            edit === 'operation'
              ? full.editOperation(full.document)
              : edit === 'early'
                ? full.editEarly(full.document)
                : full.editLate(full.document);
          // Settle the edited document once, then sample repeated warm edits
          // alternating between two values to avoid measuring a no-op.
          await run(`${edit}-warmup`, 0, full.document);
          const timings: number[] = [];
          let current = edited;
          for (let sample = 1; sample <= samples; sample += 1) {
            const result = await run(`${edit}-warm`, sample, current);
            timings.push(result.elapsedMs);
            const fresh = await create({ historyCheckpointLimit: 0 });
            try {
              const oracle = await fresh.syncDocument(current);
              const warmState = normalized(result.state);
              const freshState = normalized(oracle);
              const difference = firstDifference(warmState, freshState);
              appendFileSync(
                rawPath,
                JSON.stringify({
                  provenance,
                  session,
                  family,
                  historyFeatures: count,
                  phase: `${edit}-parity`,
                  sample,
                  status: difference ? 'mismatch' : 'equal',
                  firstDifference: difference
                }) + '\n'
              );
              expect(
                difference,
                `${family}/${count}/${edit}: ${difference ?? 'equal'}`
              ).toBeUndefined();
            } finally {
              fresh.dispose();
            }
            current = sample % 2 === 1 ? full.document : edited;
          }
          summaries.push({
            provenance,
            session,
            family,
            historyFeatures: count,
            phase: `${edit}-warm`,
            samples: timings.length,
            medianMs: percentile(timings, 0.5),
            p95Ms: percentile(timings, 0.95),
            parity:
              'warm derived state equals fresh adapter with history checkpoints disabled'
          });
        }
        expect(previous).toBeDefined();
      } finally {
        measuredAdapter.dispose();
      }
    }
  }
  const summaryPath = resolve(output, `${session}-summary.json`);
  writeFileSync(
    summaryPath,
    JSON.stringify({ provenance, summaries }, null, 2) + '\n'
  );
}, 1_800_000);
