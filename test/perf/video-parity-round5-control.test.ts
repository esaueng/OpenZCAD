/** Read-only diagnosis of the actual UI source before A4. */
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { applyEdgeModifier } from '../../packages/kernel-adapter/src/exact-edge-modifiers';
import { countBlendFaces } from '../../packages/kernel-adapter/src/exact-brep';
import { measureFaceGeometry } from '../../packages/kernel-adapter/src/exact-measure';
import { inspectTriangleMeshClosure } from '../../packages/kernel-adapter/src/boolean-result-validation';

it.skipIf(!process.env.VIDEO_PARITY_SOURCE_DOC)(
  'compares raw and adapter A4 routes on the captured body',
  async () => {
    const a = await createExactKernelAdapter({
      resolveSourceBytes: async () =>
        new Uint8Array(
          readFileSync(
            join(process.env.VIDEO_PARITY_INPUT!, 'Gentle-Gecko-W-Fillet.step')
          )
        )
    });
    try {
      const doc = JSON.parse(
        readFileSync(process.env.VIDEO_PARITY_SOURCE_DOC!, 'utf8')
      ) as ProjectDocument;
      if (process.env.VIDEO_PARITY_CONTROL_CHAMFER_V2 === '1')
        for (const n of Object.values(doc.nodes))
          if (n.kind === 'feature' && n.data.featureKind === 'chamfer')
            n.data.distance2 = n.data.distance;
      const d = await a.syncDocument(doc);
      const debug = a as unknown as {
        historyKernel: RemusKernel;
        currentMassSnapshot: { bodies: Map<string, { solid: number }> };
      };
      const k = debug.historyKernel;
      const solid = debug.currentMassSnapshot.bodies.get(
        d.exportableBodyIds[0]!
      )!.solid;
      if (process.env.VIDEO_PARITY_CONTROL_A7 === '1') {
        const faces = [...k.getSolidFaces(solid)];
        const boss = faces.find((f) => {
          const g = measureFaceGeometry(k, f);
          return (
            g?.radius === 6 &&
            g.axisEnd &&
            g.axisStart &&
            Math.abs(g.axisEnd.z - g.axisStart.z) > 5
          );
        })!;
        const rows = [];
        try {
          const p = k.prepareResizeCylindricalFace(solid, boss);
          const r = (
            JSON.parse(k.commitPreparedGroupEditJournaled(p, 7.3)) as {
              solid: number;
            }
          ).solid;
          rows.push({
            strict: k.validateSolid(r),
            faces: k.getSolidFaces(r).length,
            volume: k.volume(r, 0.005)
          });
        } catch (error) {
          rows.push({ error: String(error) });
        }
        writeFileSync(
          process.env.VIDEO_PARITY_CONTROL_OUT!,
          JSON.stringify(
            {
              warnings: d.warnings,
              sourceVolume: k.volume(solid, 0.005),
              sourceFaces: faces.length,
              rows
            },
            null,
            2
          )
        );
        return;
      }
      if (process.env.VIDEO_PARITY_CONTROL_CHAIN === '1') {
        const checkpoint = k.checkpoint();
        const rows = [];
        for (const route of ['prepared', 'evolution'] as const) {
          k.restore(checkpoint);
          try {
            const band = [...k.getSolidFaces(solid)].find((f) => {
              const g = measureFaceGeometry(k, f);
              return (
                g?.radius === 4 &&
                g.axisStart &&
                g.axisEnd &&
                Math.abs(g.axisEnd.y - g.axisStart.y) > 5
              );
            })!;
            const resized =
              route === 'prepared'
                ? (
                    JSON.parse(
                      k.commitPreparedGroupEditJournaled(
                        k.prepareResizeBlend(solid, band, 4),
                        1.5
                      )
                    ) as { solid: number }
                  ).solid
                : k.resizeBlendWithEvolution(solid, band, 4, 1.5).result.solid;
            const volume = k.volume(resized, 0.005);
            const seam = [...k.getSolidFaces(resized)].find((f) => {
              const g = measureFaceGeometry(k, f);
              return (
                g?.radius === 4 &&
                g.axisStart &&
                g.axisEnd &&
                g.axisStart.y < -1 &&
                Math.abs(g.axisEnd.z - g.axisStart.z) > 5
              );
            })!;
            const prepared = k.prepareResizeBlend(resized, seam, 4);
            const concave = (
              JSON.parse(k.commitPreparedGroupEditJournaled(prepared, 2)) as {
                solid: number;
              }
            ).solid;
            rows.push({
              route,
              volume,
              concaveVolume: k.volume(concave, 0.005),
              strict: k.validateSolid(concave)
            });
          } catch (error) {
            rows.push({ route, error: String(error) });
          }
        }
        writeFileSync(
          process.env.VIDEO_PARITY_CONTROL_OUT!,
          JSON.stringify({ rows }, null, 2)
        );
        return;
      }
      const edges = [...k.getSolidEdges(solid)].filter((e) => {
        const p = [...k.getEdgeVertices(e)];
        return (
          p.length === 6 &&
          [0, 3].every(
            (i) =>
              Math.abs(p[i]! - 30) < 1e-6 && Math.abs(p[i + 2]! - 24) < 1e-6
          )
        );
      });
      expect(edges).toHaveLength(1);
      const checkpoint = k.checkpoint();
      const source = {
        bounds: [...k.boundingBox(solid)],
        bands: countBlendFaces(k, solid),
        volume: k.volume(solid, 0.005)
      };
      const rows = [];
      for (const radius of [1.5, 3.7])
        for (const route of [
          'plain',
          'detailed',
          'evolution',
          'adapter'
        ] as const) {
          const fast = process.env.VIDEO_PARITY_CONTROL_FAST === '1';
          if (fast && (radius !== 1.5 || route !== 'plain')) continue;
          k.restore(checkpoint);
          const notes: unknown[] = [];
          const started = performance.now();
          try {
            const raw =
              route === 'plain'
                ? k.fillet(solid, Uint32Array.from(edges), radius)
                : route === 'detailed'
                  ? k.filletDetailed(
                      solid,
                      Uint32Array.from(edges),
                      radius,
                      false
                    )
                  : route === 'evolution'
                    ? k.filletWithEvolution(
                        solid,
                        Uint32Array.from(edges),
                        radius
                      )
                    : applyEdgeModifier(
                        k,
                        solid,
                        edges,
                        'fillet',
                        radius,
                        (...n) => notes.push(n),
                        () => {}
                      );
            const output =
              typeof raw === 'number'
                ? raw
                : raw && 'value' in raw
                  ? raw.value
                  : raw && 'result' in raw
                    ? raw.result.solid
                    : null;
            let health;
            if (typeof output === 'number') {
              const m = k.tessellateSolidGroupedBinary(output, 0.005, 0.06);
              try {
                let fineBounds;
                if (fast) {
                  const probes = [];
                  for (const face of k.getSolidFaces(output)) {
                    const sheet = k.makeSheetBody(Uint32Array.of(face));
                    const bounds = [...k.sheetBoundingBox(sheet)];
                    if (bounds[3]! <= 30.00003) continue;
                    try {
                      const fine = k.tessellateFace(face, 0.0000075, 0.06);
                      try {
                        let maxX = -Infinity;
                        const p = fine.positions;
                        for (let i = 0; i < p.length; i += 3)
                          maxX = Math.max(maxX, p[i]!);
                        probes.push({ face, bounds, maxX });
                      } finally {
                        fine.free();
                      }
                    } catch (error) {
                      probes.push({ face, bounds, error: String(error) });
                    }
                  }
                  fineBounds = probes;
                }
                health = {
                  fineBounds,
                  strict: k.validateSolid(output),
                  mesh: inspectTriangleMeshClosure(m.positions, m.indices),
                  bounds: [...k.boundingBox(output)],
                  bands: countBlendFaces(k, output),
                  volume: k.volume(output, 0.005)
                };
              } finally {
                m.free();
              }
            }
            rows.push({
              radius,
              route,
              elapsedMs: performance.now() - started,
              notes,
              raw: route === 'detailed' ? raw : undefined,
              output,
              health
            });
          } catch (error) {
            rows.push({
              radius,
              route,
              elapsedMs: performance.now() - started,
              notes,
              error: String(error)
            });
          }
        }
      writeFileSync(
        process.env.VIDEO_PARITY_CONTROL_OUT!,
        JSON.stringify({ source, rows }, null, 2)
      );
    } finally {
      a.dispose();
    }
  },
  180_000
);
