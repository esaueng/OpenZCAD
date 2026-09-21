// Sequential optimized-WASM history-cache benchmark:
// installed WASM, syncDocument timing boundary, stage/counter collection and
// warm-versus-fresh normalization. Run deliberately with the perf config.
import { it, expect } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  toUserId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import type {
  RebuildCacheEvent,
  ExactKernelAdapter
} from '../../packages/kernel-adapter/src/exact';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';

const mode = process.env.HISTORY_MODE ?? 'bounded';
const out = process.env.HISTORY_OUT ?? 'artifacts/history-cache';
const samples = Number(process.env.HISTORY_SAMPLES ?? 5);
const session = Number(process.env.HISTORY_SESSION ?? 0);
const filter = process.env.HISTORY_FILTER ?? 'boxes';
import { createExactKernelAdapter as create } from '@openzcad/kernel-adapter/exact';
mkdirSync(out, { recursive: true });
const output = `${out}/${mode}-${filter}${session ? '-session' : ''}.jsonl`;

function memory(adapter: ExactKernelAdapter) {
  const state = adapter as unknown as {
    historyKernel: RemusKernel | null;
    historyCheckpoints: unknown[];
    measuredShapeCacheBytes: number;
  };
  return {
    ...process.memoryUsage(),
    wasmBytes: (
      globalThis as unknown as { historyWasmMemories?: WebAssembly.Memory[] }
    ).historyWasmMemories?.map((memory) => memory.buffer.byteLength),
    retained: state.historyCheckpoints.length,
    kernelRetained: state.historyKernel?.checkpointCount() ?? 0,
    measuredBufferBytes: state.measuredShapeCacheBytes
  };
}
function normalized({ updatedAt: _updatedAt, ...derived }: DerivedState) {
  return {
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
}
function changed(document: ProjectDocument, index: number, width: number) {
  return updateFeature(document, {
    featureId: listFeaturesInOrder(document)[index]!.featureId,
    data: { dimensions: { width, height: 10, depth: 10 } }
  });
}
async function parity(
  document: ProjectDocument,
  actual: DerivedState,
  name: string
) {
  const fresh = await create({ historyCheckpointLimit: 0 });
  try {
    const expected = await fresh.syncDocument(document);
    const warm = normalized(actual),
      cold = normalized(expected);
    expect(warm).toEqual(cold);
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    writeFileSync(
      `${out}/${mode}-${name}-parity.json`,
      JSON.stringify(
        {
          equal: true,
          warmSha256: digest(warm),
          freshSha256: digest(cold),
          bodies: Object.keys(actual.bodyRepresentations).length,
          normalization:
            'Only updatedAt and mesh vertex/index layout excluded, matching existing harness.'
        },
        null,
        2
      )
    );
  } finally {
    fresh.dispose();
  }
}

it('sequential history-cache benchmark', async () => {
  if (filter === 'towel' && !process.env.HISTORY_TOWEL_STEP)
    throw new Error('Set HISTORY_TOWEL_STEP to a local STEP fixture.');
  for (const count of session
    ? [33]
    : filter === 'towel'
      ? [32, 33, 48]
      : [31, 32, 33, 48, 80]) {
    const name = `${filter}-${count}`;
    let document = createProjectDocument(name, toUserId('perf'));
    if (filter === 'towel')
      document = importStepBody(document, {
        name: 'towel',
        artifactId: 'perf',
        sourceName: 'towel.step',
        stepText: readFileSync(process.env.HISTORY_TOWEL_STEP!, 'utf8')
      }).document;
    for (let i = document.featureOrder.length; i < count; i++)
      document = addPrimitiveFeature(document, {
        name: `Box${i}`,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    let cache: RebuildCacheEvent | undefined;
    const adapter = await create({
      onRebuildCacheEvent: (event) => {
        cache = event;
      }
    });
    let actual: DerivedState;
    let last = document;
    const run = async (
      next: ProjectDocument,
      phase: string,
      sample: number
    ) => {
      const stages: unknown[] = [];
      const start = performance.now();
      actual = await adapter.syncDocument(next, (event) => {
        stages.push(event);
      });
      const ms = performance.now() - start;
      last = next;
      expect(actual.warnings).toEqual([]);
      const row = {
        name,
        mode,
        phase,
        sample,
        ms,
        cache,
        memory: memory(adapter),
        stages
      };
      if (
        !session ||
        sample === 0 ||
        sample % 100 === 0 ||
        sample > session - 10
      ) {
        appendFileSync(output, JSON.stringify(row) + '\n');
        console.log(
          name,
          phase,
          sample,
          ms.toFixed(3),
          JSON.stringify(row.memory)
        );
      }
      expect(row.memory.retained).toBe(row.memory.kernelRetained);
      expect(row.memory.retained).toBeLessThanOrEqual(32);
    };
    try {
      await run(document, 'cold', 0);
      if (session) {
        for (let i = 1; i <= session; i++)
          await run(changed(document, count - 1, 10 + (i % 2)), 'session', i);
      } else {
        for (let i = 1; i <= samples; i++)
          await run(changed(document, count - 1, 10 + (i % 2)), 'late', i);
        await parity(last, actual!, `${name}-late`);
        if (filter === 'boxes') {
          for (const [phase, index] of [
            ['middle', Math.floor(count / 2)],
            ['early', 0]
          ] as const) {
            // Settle all other edits before measuring this location.
            await adapter.syncDocument(document);
            for (let i = 1; i <= samples; i++)
              await run(changed(document, index, 10 + (i % 2)), phase, i);
            await parity(last, actual!, `${name}-${phase}`);
          }
        }
      }
      if (session) await parity(last, actual!, `${name}-session`);
      const beforeDispose = memory(adapter);
      adapter.dispose();
      globalThis.gc?.();
      appendFileSync(
        output,
        JSON.stringify({
          name,
          mode,
          phase: 'disposed',
          beforeDispose,
          memory: memory(adapter)
        }) + '\n'
      );
    } finally {
      adapter.dispose();
    }
  }
});
