import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeDocument,
  withoutDerivedProjection,
  directEditBody,
  filletEdges,
  chamferEdges
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';
import { edgeRunSelections } from '../../packages/viewport/src/pick/edgeChain';
import { edgeFingerprint } from '../../packages/kernel-adapter/src/exact-witnesses';
const input = process.env.VIDEO_PARITY_INPUT;
it.skipIf(!input)(
  'compares legacy and v2 A4 after convex resize and vertical R1',
  async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let doc = withoutDerivedProjection(
        normalizeDocument(
          (
            JSON.parse(
              readFileSync(
                join(input!, 'Gentle-Gecko-W-Fillet.openzcad'),
                'utf8'
              )
            ) as { document: ProjectDocument }
          ).document
        )
      );
      let s = await adapter.syncDocument(doc);
      let id = s.exportableBodyIds[0]!;
      const f = s.bodyRepresentations[id]!.topology!.faces.find(
        (f) =>
          f.geometry?.radius === 4 &&
          Math.abs(f.geometry.axisEnd!.y - f.geometry.axisStart!.y) > 5
      )!;
      const c = blendCarrierSnapshot(f.geometry)!;
      doc = directEditBody(doc, {
        name: 'Convex 1.9',
        targetBodyId: id,
        operation: {
          kind: 'resize-blend',
          faceHash: f.hash,
          faceReference: f.reference,
          surfaceClass: 'cylinder',
          recordedRadius: 4,
          recordedCenter: c.center,
          recordedAxis: c.axis,
          newRadius: 1.9
        }
      }).document;
      s = await adapter.syncDocument(doc);
      id = s.exportableBodyIds[0]!;
      const edge = s.bodyRepresentations[id]!.topology!.edges.find((e) =>
        Array.from(e.points).every((v, i) =>
          i % 3 === 0
            ? Math.abs(v) < 1e-6
            : i % 3 === 1
              ? Math.abs(v - 18) < 1e-6
              : true
        )
      )!;
      expect(edge).toBeDefined();
      doc = filletEdges(doc, {
        name: 'Vertical R1',
        targetBodyId: id,
        edgeHashes: [edge.hash],
        edgeReferences: edge.reference ? [edge.reference] : undefined,
        size: 1
      }).document;
      s = await adapter.syncDocument(doc);
      id = s.exportableBodyIds[0]!;
      const free = s.bodyRepresentations[id]!.topology!.edges.find((e) =>
        Array.from(e.points).every((v, i) =>
          i % 3 === 0
            ? Math.abs(v - 30) < 1e-5
            : i % 3 === 2
              ? Math.abs(v - 24) < 1e-5
              : true
        )
      )!;
      const chain = edgeRunSelections(
        s.bodyRepresentations[id]!.topology!.edges,
        free.topologyId,
        id
      );
      const io = await loadRemusTranslators();
      const k = new RemusKernel();
      const rows: unknown[] = [];
      try {
        const solid = k.deserializeSolids(
          io.importStep(
            new TextEncoder().encode(await adapter.exportStep(doc, [id]))
          )
        )[0]!;
        const edge = Array.from(k.getSolidEdges(solid)).find((e) =>
          Array.from(k.tessellateEdge(e, 8)).every((v, i) =>
            i % 3 === 0
              ? Math.abs(v - 30) < 1e-5
              : i % 3 === 2
                ? Math.abs(v - 24) < 1e-5
                : true
          )
        )!;
        expect(edge).toBeDefined();
        const handles = chain.map((e) =>
          Array.from(k.getSolidEdges(solid)).find(
            (h) => edgeFingerprint(k, h) === e.hash
          )!
        );
        for (const method of ['legacy', 'v2'] as const) {
          const t = performance.now();
          try {
            const result =
              method === 'v2'
                ? k.chamferV2(solid, new Uint32Array([edge]), 0.7, 0.7)
                : k.chamferWithEvolution(solid, new Uint32Array([edge]), 0.7)
                    .result.solid;
            rows.push({
              method,
              ms: performance.now() - t,
              faces: k.getSolidFaces(result).length,
              valid: k.validateSolidRelaxed(result)
            });
          } catch (e) {
            rows.push({ method, error: String(e), ms: performance.now() - t });
          }
        }
        for (const method of ['legacy-chain', 'v2-chain'] as const) {
          const t = performance.now();
          try {
            const result =
              method === 'v2-chain'
                ? k.chamferV2(solid, new Uint32Array(handles), 0.7, 0.7)
                : k.chamferWithEvolution(solid, new Uint32Array(handles), 0.7)
                    .result.solid;
            rows.push({
              method,
              edges: handles.length,
              ms: performance.now() - t,
              faces: k.getSolidFaces(result).length,
              valid: k.validateSolidRelaxed(result)
            });
          } catch (e) {
            rows.push({ method, error: String(e), ms: performance.now() - t });
          }
        }
      } finally {
        k.free();
      }
      writeFileSync(
        join(
          process.env.VIDEO_PARITY_OUT ??
            'artifacts/video-parity-phase3-round2',
          'chamfer-route.json'
        ),
        JSON.stringify(rows, null, 2)
      );
      const candidate = chamferEdges(doc, {
        name: 'End chamfer',
        targetBodyId: id,
        edgeHashes: chain.map((e) => e.hash!),
        edgeReferences: chain.every((e) => e.reference?.kind === 'edge')
          ? chain.flatMap((e) =>
              e.reference?.kind === 'edge' ? [e.reference] : []
            )
          : undefined,
        size: 0.7
      }).document;
      const after = await adapter.syncDocument(candidate);
      expect(after.warnings.filter((w) => w.includes('End chamfer'))).toEqual(
        []
      );
      expect(
        after.bodyRepresentations[after.exportableBodyIds[0]!]!.faceCount
      ).toBeGreaterThan(s.bodyRepresentations[id]!.faceCount);
      doc = candidate;
      s = after;
      id = s.exportableBodyIds[0]!;
      const finish: unknown[] = [];
      const save = () =>
        writeFileSync(
          join(
            process.env.VIDEO_PARITY_OUT ??
              'artifacts/video-parity-phase3-round2',
            'finish-adapter.json'
          ),
          JSON.stringify(finish, null, 2)
        );
      const bottom = s.bodyRepresentations[id]!.topology!.edges.find((e) =>
        Array.from(e.points).every((v, i) =>
          i % 3 === 1
            ? Math.abs(v) < 1e-6
            : i % 3 === 2
              ? Math.abs(v) < 1e-6
              : true
        )
      )!;
      expect(bottom).toBeDefined();
      const lower = edgeRunSelections(
        s.bodyRepresentations[id]!.topology!.edges,
        bottom.topologyId,
        id
      );
      const lowerDoc = chamferEdges(doc, {
        name: 'Bottom chain',
        targetBodyId: id,
        edgeHashes: lower.map((e) => e.hash!),
        edgeReferences: lower.every((e) => e.reference?.kind === 'edge')
          ? lower.flatMap((e) =>
              e.reference?.kind === 'edge' ? [e.reference] : []
            )
          : undefined,
        size: 0.8
      }).document;
      let t = performance.now();
      const lowerState = await adapter.syncDocument(lowerDoc);
      const warnings = lowerState.warnings.filter((w) =>
        w.includes('Bottom chain')
      );
      finish.push({
        label: 'A6',
        edges: lower.length,
        ms: performance.now() - t,
        faces:
          lowerState.bodyRepresentations[lowerState.exportableBodyIds[0]!]!
            .faceCount,
        warnings
      });
      save();
      if (warnings.length) {
        const k = new RemusKernel();
        try {
          const io = await loadRemusTranslators();
          const solid = k.deserializeSolids(
            io.importStep(
              new TextEncoder().encode(await adapter.exportStep(doc, [id]))
            )
          )[0]!;
          const handles = lower.map((e) =>
            Array.from(k.getSolidEdges(solid)).find(
              (h) => edgeFingerprint(k, h) === e.hash
            )!
          );
          for (const method of ['legacy', 'v2'] as const) {
            const t = performance.now();
            try {
              const result =
                method === 'v2'
                  ? k.chamferV2(solid, new Uint32Array(handles), 0.8, 0.8)
                  : k.chamferWithEvolution(solid, new Uint32Array(handles), 0.8)
                      .result.solid;
              finish.push({
                label: `A6 raw ${method}`,
                edges: handles.length,
                ms: performance.now() - t,
                faces: k.getSolidFaces(result).length,
                valid: k.validateSolidRelaxed(result)
              });
            } catch (e) {
              finish.push({
                label: `A6 raw ${method}`,
                error: String(e),
                ms: performance.now() - t
              });
            }
            save();
          }
        } finally {
          k.free();
        }
        return;
      }
      doc = lowerDoc;
      s = lowerState;
      id = s.exportableBodyIds[0]!;
      for (const diameter of [14.6, 17, 21.1, 14.7]) {
        const before = s.bodyRepresentations[id]!;
        const wall = before.topology!.faces.find(
          (f) =>
            f.geometry?.surfaceType === 'cylinder' &&
            Math.abs(f.geometry.axisStart!.x) < 1e-6 &&
            Math.abs(f.geometry.axisStart!.y) < 1e-6
        )!;
        expect(wall).toBeDefined();
        const g = wall.geometry!;
        const candidate = directEditBody(doc, {
          name: `Boss ${diameter}`,
          targetBodyId: id,
          operation: {
            kind: 'resize-cylindrical-face',
            faceHash: wall.hash,
            faceReference: wall.reference,
            sourceRadius: g.radius!,
            sourceAxisStart: g.axisStart!,
            sourceAxisEnd: g.axisEnd!,
            concavity: 'boss',
            radius: diameter / 2
          }
        }).document;
        t = performance.now();
        if (diameter === 21.1) {
          const preview = await adapter.previewGeometry(candidate, {
            deferTopology: true
          });
          const restored = await adapter.syncDocument(doc);
          expect(restored.bodyRepresentations[id]!.mesh).toEqual(before.mesh);
          finish.push({
            label: `A7 ${diameter}`,
            previewMs: performance.now() - t,
            warnings: preview.warnings,
            cancelUnchanged: true
          });
          save();
          continue;
        }
        const next = await adapter.syncDocument(candidate);
        const warnings = next.warnings.filter((w) =>
          w.includes(`Boss ${diameter}`)
        );
        finish.push({
          label: `A7 ${diameter}`,
          ms: performance.now() - t,
          warnings,
          faces:
            next.bodyRepresentations[next.exportableBodyIds[0]!]!.faceCount,
          radii: next.bodyRepresentations[
            next.exportableBodyIds[0]!
          ]!.topology!.faces.flatMap((f) =>
            f.geometry?.radius ? [f.geometry.radius] : []
          )
        });
        save();
        if (warnings.length) return;
        doc = candidate;
        s = next;
        id = s.exportableBodyIds[0]!;
      }
    } finally {
      adapter.dispose();
    }
  },
  180_000
);
