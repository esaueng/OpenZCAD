/**
 * CPU costs paid when orbiting a curved body or highlighting edges. Run on
 * the same host and pinned kernel with each checkout, writing to a fresh file:
 *
 * OZ_VIEWER_CPU_PERF_OUT=/tmp/viewer.jsonl pnpm exec vitest run \
 *   packages/viewport/src/render/interaction-perf.test.ts --maxWorkers=1
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as THREE from 'three';
import { toBodyId } from '@openzcad/shared';
import { createBodyEdgeOverlay } from './edgeOverlay';
import {
  createSilhouetteLines,
  silhouetteCandidates,
  type SilhouetteCandidates,
  updateSilhouette
} from './silhouette';

const output = process.env.OZ_VIEWER_CPU_PERF_OUT;

// Shuffle 31/32 of the edges and leave the tail in surface order. A few
// blocks still cull on this mesh even when nearly all bounds checks miss.
function shuffleCandidates({
  positions,
  normalsA,
  normalsB
}: SilhouetteCandidates) {
  let seed = 17;
  for (let i = Math.floor((positions.length / 6) * (31 / 32)) - 1; i > 0; i--) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    for (const values of [positions, normalsA, normalsB]) {
      const stride = values === positions ? 6 : 3;
      for (let k = 0; k < stride; k++) {
        const a = stride * i + k;
        const b = stride * j + k;
        const tmp = values[a]!;
        values[a] = values[b]!;
        values[b] = tmp;
      }
    }
  }
}

function report(samples: number[], details: Record<string, unknown>) {
  samples.sort((left, right) => left - right);
  appendFileSync(
    output!,
    JSON.stringify({
      ...details,
      samples: samples.length,
      p50Ms: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.floor(samples.length * 0.95)]
    }) + '\n'
  );
}

it.skipIf(!output)(
  'measures the CPU outline updates for an orbit',
  async () => {
    const { createExactKernelAdapter } =
      await import('@openzcad/kernel-adapter/exact');
    const { FRAME_TIMING_SCENES } =
      await import('../../../../test/fixtures/frame-timing-scenes');
    for (const id of [
      'rounded-block',
      'torus',
      'interleaved-torus',
      'rotational-sleeve'
    ]) {
      const adapter = await createExactKernelAdapter();
      try {
        const scene = FRAME_TIMING_SCENES.find(
          (entry) => entry.id === (id === 'interleaved-torus' ? 'torus' : id)
        )!;
        const document = await scene.build(adapter);
        const model = await adapter.syncDocument(document);
        const body = Object.values(model.bodyRepresentations).find(
          (entry) => !entry.consumed
        )!;
        const candidates = silhouetteCandidates(
          body.mesh,
          body.topology!.faces
        )!;
        expect(candidates).not.toBeNull();
        if (id === 'interleaved-torus') shuffleCandidates(candidates);
        const options = { color: 0, linewidth: 1 };
        const details = { id, candidates: candidates.positions.length / 6 };
        const installs: number[] = [];
        const firstMoves: number[] = [];
        const initial = new THREE.PerspectiveCamera();
        initial.position.set(80, 0, 18);
        initial.updateMatrixWorld();
        const moved = initial.clone();
        moved.position.y = 1;
        moved.updateMatrixWorld();
        for (let sample = 0; sample < 10; sample++) {
          const started = performance.now();
          const installed = createSilhouetteLines(candidates, options);
          if (sample) installs.push(performance.now() - started);
          updateSilhouette(installed, initial);
          const movedAt = performance.now();
          updateSilhouette(installed, moved);
          if (sample) firstMoves.push(performance.now() - movedAt);
          installed.geometry.dispose();
          installed.material.dispose();
        }
        report(installs, { ...details, phase: 'outline-install' });
        report(firstMoves, { ...details, phase: 'first-view-change' });
        const lines = createSilhouetteLines(candidates, options);
        const attribute = lines.geometry.getAttribute(
          'instanceStart'
        ) as THREE.InterleavedBufferAttribute;
        const positions = attribute.data.array as Float32Array;
        for (const projection of ['perspective', 'orthographic'] as const) {
          const camera =
            projection === 'perspective'
              ? new THREE.PerspectiveCamera(50, 1, 0.1, 500)
              : new THREE.OrthographicCamera(-30, 30, 30, -30, 0.1, 500);
          const samples: number[] = [];
          const digest = createHash('sha256');
          // Two complete orbits after warm-up. Hash one complete orbit, with
          // the drawn segment count delimiting each frame in the digest.
          for (let frame = 0; frame < 300; frame++) {
            const angle = ((frame % 120) * Math.PI) / 60;
            camera.position.set(
              80 * Math.cos(angle),
              80 * Math.sin(angle),
              30 * Math.sin(2 * angle) + 18
            );
            camera.lookAt(0, 0, 0);
            camera.updateMatrixWorld();
            const started = performance.now();
            updateSilhouette(lines, camera);
            if (frame >= 60) samples.push(performance.now() - started);
            if (frame >= 60 && frame < 180) {
              const count = lines.geometry.instanceCount;
              digest.update(String(count) + ':');
              digest.update(
                Buffer.from(positions.buffer, positions.byteOffset, count * 24)
              );
            }
          }
          report(samples, {
            ...details,
            projection,
            phase: 'orbit',
            sha256: digest.digest('hex')
          });
        }
        lines.geometry.dispose();
        lines.material.dispose();
      } finally {
        adapter.dispose();
      }
    }
  },
  120_000
);

it.skipIf(!output)(
  'measures changing a hover highlight on sparse and dense topology',
  () => {
    const bodyId = toBodyId('body_overlay');
    for (const count of [12, 20_000]) {
      const edges = Array.from({ length: count }, (_, i) => ({
        topologyId: 'edge-' + i,
        hash: i + 1,
        points: [0, i, 0, 1, i, 0]
      }));
      const overlay = createBodyEdgeOverlay({
        bodyId,
        topology: { faces: [], edges }
      });
      for (const run of [1, 4]) {
        const samples: number[] = [];
        for (let move = 0; move < 360; move++) {
          const index = (move * 271) % count;
          const owner = overlay.ownerAtSegment(index)!;
          const continuation = Array.from(
            { length: run - 1 },
            (_, j) => edges[(index + j + 1) % count]!.topologyId
          );
          const started = performance.now();
          overlay.setHovered(owner, continuation);
          if (move >= 120) samples.push(performance.now() - started);
          expect(overlay.hoverEdges.geometry.instanceCount).toBe(run);
        }
        report(samples, { phase: 'hover', edges: count, highlighted: run });
      }
    }
  }
);
