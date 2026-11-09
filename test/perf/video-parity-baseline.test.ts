/** Read-only supplied-fixture probe. See docs/qa/video-parity-baseline.md. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import {
  measureFaceGeometry,
  blendCarrierSnapshot
} from '../../packages/kernel-adapter/src/exact-measure';
import {
  edgeSampleOf,
  faceFingerprint,
  edgeFingerprint
} from '../../packages/kernel-adapter/src/exact-witnesses';
import {
  createProjectDocument,
  importStepBody,
  normalizeDocument,
  withoutDerivedProjection,
  directEditBody,
  filletEdges,
  chamferEdges
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { inspectTriangleMeshClosure } from '../../packages/kernel-adapter/src/boolean-result-validation';
import { edgeRunSelections } from '../../packages/viewport/src/pick/edgeChain';
import type {
  ProjectDocument,
  GeometryBodyRepresentation,
  DirectEditOperation
} from '@openzcad/shared';

const input = process.env.VIDEO_PARITY_INPUT;
const round2 = process.env.VIDEO_PARITY_ROUND2 === '1';
const out = process.env.VIDEO_PARITY_OUT ?? 'artifacts/video-parity';
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (e: unknown) => (e instanceof Error ? e.message : String(e));
const summary = (body: GeometryBodyRepresentation | undefined) =>
  body && {
    faces: body.faceCount,
    volume: 'volume' in body ? body.volume : undefined,
    surfaces: (body.topology?.faces ?? []).reduce<Record<string, number>>(
      (a, f) => {
        const t = f.geometry?.surfaceType ?? 'unknown';
        a[t] = (a[t] ?? 0) + 1;
        return a;
      },
      {}
    ),
    geometryHash: digest({ mesh: body.mesh, topology: body.topology }),
    meshClosure: inspectTriangleMeshClosure(
      body.mesh.vertices,
      body.mesh.indices
    )
  };

it.skipIf(!input)(
  'records the supplied direct-edit workflow without changing features',
  async () => {
    mkdirSync(out, { recursive: true });
    const rows: unknown[] = [];
    const report: Record<string, unknown> = {
      appSource: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim(),
      rows
    };
    const save = () =>
      writeFileSync(
        join(out, process.env.VIDEO_PARITY_REPORT ?? 'adapter.json'),
        JSON.stringify(report, null, 2)
      );
    const source = (filleted = true, step = false): ProjectDocument => {
      const name = filleted ? 'Gentle-Gecko-W-Fillet' : 'Gentle-Gecko';
      if (!step)
        return withoutDerivedProjection(
          normalizeDocument(
            (
              JSON.parse(
                readFileSync(join(input!, `${name}.openzcad`), 'utf8')
              ) as { document: ProjectDocument }
            ).document
          )
        );
      return importStepBody(
        createProjectDocument('Video parity', toUserId('baseline')),
        {
          name,
          sourceName: `${name}.step`,
          artifactId: 'baseline_step',
          stepText: readFileSync(join(input!, `${name}.step`), 'utf8')
        }
      ).document;
    };
    for (const step of [false, true]) {
      const mode = step ? 'step' : 'history';
      const base = source(true, step);
      const adapter = await createExactKernelAdapter();
      try {
        const t = performance.now();
        const initial = await adapter.syncDocument(base);
        const id = initial.exportableBodyIds[0]!;
        const body = initial.bodyRepresentations[id]!;
        report[`${mode}Initial`] = {
          ms: performance.now() - t,
          warnings: initial.warnings,
          body: summary(body),
          faces: body.topology?.faces,
          edges: body.topology?.edges
        };
        save();
        expect(body).toBeDefined();
        const faces = body.topology!.faces;
        const cap = faces
          .filter(
            (f) =>
              f.geometry?.surfaceType === 'plane' &&
              (f.geometry.normal?.z ?? 0) > 0.99
          )
          .sort((a, b) => b.geometry!.center.z - a.geometry!.center.z)[0]!;
        const wall = faces.find(
          (f) =>
            f.geometry?.surfaceType === 'cylinder' &&
            Math.abs((f.geometry.radius ?? 0) - 6) < 1e-5
        )!;
        const blends = faces.filter(
          (f) =>
            f.geometry?.surfaceType === 'cylinder' &&
            Math.abs((f.geometry.radius ?? 0) - 4) < 1e-5
        );
        const edges = body.topology!.edges;
        const free = edges.find(
          (e) =>
            e.points.length >= 6 &&
            Array.from(e.points).every((v, i) =>
              i % 3 === 0
                ? Math.abs(v - 30) < 1e-5
                : i % 3 === 2
                  ? Math.abs(v - 24) < 1e-5
                  : true
            )
        );
        const bottom = edges.find(
          (e) =>
            e.displayRole !== 'seam' &&
            (!round2 ||
              Array.from(e.points).every(
                (v, i) => i % 3 !== 1 || Math.abs(v) < 1e-5
              )) &&
            Array.from(e.points).every(
              (v, i) => i % 3 !== 2 || Math.abs(v) < 1e-5
            )
        );
        const boundary = edges.find((e) =>
          round2
            ? Array.from(e.points).every((v, i) =>
                i % 3 === 0
                  ? Math.abs(v) < 1e-5
                  : i % 3 === 1
                    ? Math.abs(v - 18) < 1e-5
                    : true
              )
            : e.hash === 4186093139
        );
        report[`${mode}Boundary`] = boundary;
        const attempt = async (
          label: string,
          candidate: ProjectDocument,
          selection: unknown
        ) => {
          if (process.env.VIDEO_PARITY_RAW_ONLY === '1') return;
          if (
            process.env.VIDEO_PARITY_CASE &&
            !label.includes(process.env.VIDEO_PARITY_CASE)
          )
            return;
          const row: Record<string, unknown> = {
            mode,
            label,
            selection,
            before: summary(body)
          };
          rows.push(row);
          save();
          let start = performance.now();
          try {
            const p = await adapter.previewGeometry(candidate);
            row.previewMs = performance.now() - start;
            row.previewWarnings = p.warnings;
            row.preview = summary(
              Object.values(p.bodyRepresentations)
                .filter((b) => !b.consumed)
                .at(-1)
            );
          } catch (e) {
            row.previewMs = performance.now() - start;
            row.previewError = error(e);
          }
          start = performance.now();
          try {
            const c = await adapter.syncDocument(candidate);
            row.commitMs = performance.now() - start;
            row.warnings = c.warnings;
            row.exportable = c.exportableBodyIds;
            row.after = summary(
              c.bodyRepresentations[c.exportableBodyIds.at(-1)!]
            );
            if (c.exportableBodyIds.length) {
              const io = await loadRemusTranslators();
              const k = new RemusKernel();
              try {
                const step = await adapter.exportStep(
                  candidate,
                  c.exportableBodyIds
                );
                const ss = k.deserializeSolids(
                  io.importStep(new TextEncoder().encode(step))
                );
                row.independent = Array.from(ss, (s) => ({
                  faces: k.getSolidFaces(s).length,
                  validation: k.validateSolidDetailed(s) as unknown,
                  volume: [0.1, 0.01, 0.001].map((d) => k.volume(s, d)),
                  surfaces: Array.from(k.getSolidFaces(s), (f) =>
                    k.getSurfaceType(f)
                  )
                }));
              } finally {
                k.free();
              }
            }
          } catch (e) {
            row.commitMs = performance.now() - start;
            row.error = error(e);
          }
          const restored = await adapter.syncDocument(base);
          row.unchangedAfterDiscard =
            digest(summary(restored.bodyRepresentations[id])) ===
            digest(summary(body));
          save();
        };
        for (const offset of [round2 ? -10 : -14, 25.2, -40]) {
          const g = cap.geometry!;
          await attempt(
            `A1 cap offset ${offset}`,
            directEditBody(base, {
              name: 'Cap baseline',
              targetBodyId: id,
              operation: {
                kind: 'offset-face',
                faceHash: cap.hash,
                faceReference: cap.reference,
                sourceSurfaceType: 'plane',
                sourceArea: g.area,
                sourceCenter: g.center,
                sourceNormal: g.normal!,
                offset
              }
            }).document,
            cap
          );
        }
        for (const f of blends) {
          const g = f.geometry!;
          const longitudinal = Math.abs(g.axisEnd!.z - g.axisStart!.z) < 1;
          const carrier = blendCarrierSnapshot(g)!;
          const op: DirectEditOperation = {
            kind: 'resize-blend',
            faceHash: f.hash,
            faceReference: f.reference,
            surfaceClass: 'cylinder',
            recordedRadius: 4,
            recordedCenter: carrier.center,
            recordedAxis: carrier.axis,
            newRadius: longitudinal ? 1.5 : 2
          };
          await attempt(
            `A2 ${longitudinal ? 'convex' : 'concave'} ${f.hash}`,
            directEditBody(base, {
              name: 'Radius baseline',
              targetBodyId: id,
              operation: op
            }).document,
            f
          );
        }
        for (const [label, e, kind, size] of [
          ['A3 boundary fillet', boundary, 'fillet', 1],
          ['A4 free fillet 1.5', free, 'fillet', 1.5],
          ['A4 free fillet 3.7', free, 'fillet', 3.7],
          ['A4 free chamfer .7', free, 'chamfer', 0.7],
          ['A4 free chamfer 5', free, 'chamfer', 5],
          ['A5 negative fillet', free, 'fillet', -1],
          ['A6 single bottom chamfer', bottom, 'chamfer', 0.8]
        ] as const) {
          if (!e) {
            rows.push({ mode, label, error: 'No matching edge' });
            continue;
          }
          try {
            const args = {
              name: label,
              targetBodyId: id,
              edgeHashes: [e.hash],
              edgeReferences: e.reference ? [e.reference] : undefined,
              size
            };
            await attempt(
              label,
              (kind === 'fillet'
                ? filletEdges(base, args)
                : chamferEdges(base, args)
              ).document,
              e
            );
          } catch (e) {
            rows.push({
              mode,
              label,
              error: error(e),
              unchangedAfterDiscard: true
            });
            save();
          }
        }
        if (bottom) {
          const chain = edgeRunSelections(edges, bottom.topologyId, id);
          report[`${mode}Chain`] = chain;
          await attempt(
            'A6 tangent chain chamfer',
            chamferEdges(base, {
              name: 'Chain baseline',
              targetBodyId: id,
              edgeHashes: chain.map((e) => e.hash!),
              edgeReferences: chain.every((e) => e.reference?.kind === 'edge')
                ? chain.flatMap((e) =>
                    e.reference?.kind === 'edge' ? [e.reference] : []
                  )
                : undefined,
              size: 0.8
            }).document,
            chain
          );
        }
        for (const diameter of [14.6, 17, 21.1, 14.7, 60]) {
          const g = wall.geometry!;
          await attempt(
            `A7 diameter ${diameter}`,
            directEditBody(base, {
              name: 'Diameter baseline',
              targetBodyId: id,
              operation: {
                kind: 'resize-cylindrical-face',
                faceHash: wall.hash,
                faceReference: wall.reference,
                sourceRadius: 6,
                sourceAxisStart: g.axisStart!,
                sourceAxisEnd: g.axisEnd!,
                concavity: 'boss',
                radius: diameter / 2
              }
            }).document,
            wall
          );
        }
      } finally {
        adapter.dispose();
      }
    }
    // A0 replays the supplied saved fillet rather than inventing a different edge set.
    const a0 = await createExactKernelAdapter();
    try {
      const sharp = source(false);
      const sharpState = await a0.syncDocument(sharp);
      const seed = Object.values(source().nodes).find(
        (n) => n.kind === 'feature' && n.data.featureKind === 'fillet'
      );
      if (
        !seed ||
        seed.kind !== 'feature' ||
        seed.data.featureKind !== 'fillet'
      )
        throw new Error('Supplied fillet recipe missing');
      const filleted = filletEdges(sharp, {
        name: 'A0 saved edge recipe',
        targetBodyId: seed.data.targetBodyId,
        edgeHashes: seed.data.edgeHashes,
        edgeReferences: seed.data.edgeReferences,
        size: seed.data.radius
      }).document;
      const t = performance.now();
      const s = await a0.syncDocument(filleted);
      report.A0 = {
        before: sharpState.exportableBodyIds.map((id) =>
          summary(sharpState.bodyRepresentations[id])
        ),
        ms: performance.now() - t,
        warnings: s.warnings,
        bodies: s.exportableBodyIds.map((id) =>
          summary(s.bodyRepresentations[id])
        )
      };
      const id = s.exportableBodyIds[0]!;
      const capEdge = s.bodyRepresentations[id]!.topology!.edges.find(
        (e) =>
          e.curve?.type === 'CIRCLE' &&
          Math.abs((e.curve.circle?.radius ?? 0) - 6) < 1e-6 &&
          Array.from(e.points).every(
            (v, i) => i % 3 !== 2 || Math.abs(v - 36) < 1e-6
          )
      )!;
      const rim = filletEdges(filleted, {
        name: 'A0 supplementary R1 cap rim',
        targetBodyId: id,
        edgeHashes: [capEdge.hash],
        edgeReferences: capEdge.reference ? [capEdge.reference] : undefined,
        size: 1
      }).document;
      const rt = performance.now();
      const rs = await a0.syncDocument(rim);
      report.A0Rim = {
        ms: performance.now() - rt,
        warnings: rs.warnings,
        bodies: rs.exportableBodyIds.map((id) =>
          summary(rs.bodyRepresentations[id])
        )
      };
    } finally {
      a0.dispose();
    }
    // Raw kernel controls distinguish a binding/adapter refusal from the kernel.
    const io = await loadRemusTranslators();
    const k = new RemusKernel();
    try {
      const solids = k.deserializeSolids(
        io.importStep(
          new Uint8Array(
            readFileSync(join(input!, 'Gentle-Gecko-W-Fillet.step'))
          )
        )
      );
      const solid = solids[0]!;
      const census = (s: number) => ({
        faces: k.getSolidFaces(s).length,
        surfaces: Array.from(k.getSolidFaces(s), (f) => k.getSurfaceType(f)),
        validation: k.validateSolidDetailed(s) as unknown,
        volume: [0.1, 0.01, 0.001].map((d) => {
          try {
            return k.volume(s, d);
          } catch (e) {
            return error(e);
          }
        })
      });
      report.rawInitial = census(solid);
      const before = digest(k.serializeSolids(new Uint32Array([solid])));
      const rawRows: unknown[] = [];
      report.raw = rawRows;
      const raw = (label: string, fn: () => number) => {
        if (
          process.env.VIDEO_PARITY_CASE &&
          !label.includes(process.env.VIDEO_PARITY_CASE)
        )
          return;
        const start = performance.now();
        try {
          const result = fn();
          rawRows.push({
            label,
            ms: performance.now() - start,
            result: census(result),
            unchanged:
              before === digest(k.serializeSolids(new Uint32Array([solid])))
          });
        } catch (e) {
          rawRows.push({
            label,
            ms: performance.now() - start,
            error: error(e),
            unchanged:
              before === digest(k.serializeSolids(new Uint32Array([solid])))
          });
        }
        save();
      };
      const fs = Array.from(k.getSolidFaces(solid), (f) => ({
        f,
        g: measureFaceGeometry(k, f)
      }));
      report.rawFaces = fs;
      const cap = fs
        .filter((x) => x.g?.normal?.z && x.g.normal.z > 0.99)
        .sort((a, b) => b.g!.center.z - a.g!.center.z)[0]!.f;
      for (const distance of [round2 ? -10 : -14, 25.2, -40])
        raw(`A1 ${distance}`, () =>
          k.moveFaces(solid, new Uint32Array([cap]), distance)
        );
      for (const { f, g } of fs.filter((x) => x.g?.radius === 4)) {
        raw(`A2 face ${faceFingerprint(k, f)}`, () =>
          k.resizeBlend(
            solid,
            f,
            4,
            Math.abs(g!.axisEnd!.z - g!.axisStart!.z) < 1 ? 1.5 : 2
          )
        );
      }
      const wall = fs.find((x) => x.g?.radius === 6)!.f;
      for (const diameter of [14.6, 17, 21.1, 14.7, 60])
        raw(`A7 ${diameter}`, () =>
          k.moveFaces(solid, new Uint32Array([wall]), (diameter - 12) / 2)
        );
      for (const diameter of [14.6, 17, 21.1, 14.7, 60])
        raw(`A7 resizeCylindricalFace ${diameter}`, () =>
          k.resizeCylindricalFace(solid, wall, diameter / 2)
        );
      const es = Array.from(k.getSolidEdges(solid), (e) => ({
        e,
        s: edgeSampleOf(k, e)
      }));
      report.rawEdges = es;
      const edge = (hash: number) =>
        es.find((x) => edgeFingerprint(k, x.e) === hash)!.e;
      const chain = report.stepChain as { hash: number }[];
      raw('A6 seven-edge tangent chain', () =>
        k.chamfer(solid, new Uint32Array(chain.map((x) => edge(x.hash))), 0.8)
      );
      for (const [label, hash, kind, size] of [
        [
          'A3 boundary',
          round2 ? (report.stepBoundary as { hash: number }).hash : 4186093139,
          'fillet',
          1
        ],
        ['A4 R1.5', 2936011938, 'fillet', 1.5],
        ['A4 R3.7', 2936011938, 'fillet', 3.7],
        ['A4 C0.7', 2936011938, 'chamfer', 0.7],
        ['A4 C5', 2936011938, 'chamfer', 5],
        ['A5 negative', 2936011938, 'fillet', -1],
        ['A6 bottom', 916733619, 'chamfer', 0.8]
      ] as const)
        raw(label, () =>
          kind === 'fillet'
            ? k.fillet(solid, new Uint32Array([edge(hash)]), size)
            : k.chamfer(solid, new Uint32Array([edge(hash)]), size)
        );
      save();
    } finally {
      k.free();
    }
    save();
  },
  600_000
);
