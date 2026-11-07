/** Opt-in integration over the supplied, read-only reference recipe. */
import { it, expect, vi } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeDocument,
  withoutDerivedProjection,
  directEditBody,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import type { ProjectDocument, FaceTopology } from '@openzcad/shared';
import { createExactKernelAdapter } from '../../packages/kernel-adapter/src/exact';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';

interface PreparedBindings {
  prepareResizeBlend(s: number, f: number, r: number): number;
  prepareResizeCylindricalFace(s: number, f: number): number;
  previewPreparedGroupEdit(p: number, r: number): number;
  commitPreparedGroupEditJournaled(p: number, r: number): string;
  releasePreparedGroupEdit(p: number): boolean;
}
const input = process.env.VIDEO_PARITY_INPUT;
const proto = RemusKernel.prototype as RemusKernel & PreparedBindings;
for (const kind of ['blend', 'cylinder'] as const) {
  it.skipIf(!input || typeof proto.previewPreparedGroupEdit !== 'function')(
    `prepares ${kind} once across preview frames and commits from the source`,
    async () => {
      const adapter = await createExactKernelAdapter();
      const calls: { method: string; args: unknown[]; ms: number }[] = [];
      const methods = [
        'prepareResizeBlend',
        'prepareResizeCylindricalFace',
        'previewPreparedGroupEdit',
        'commitPreparedGroupEditJournaled',
        'releasePreparedGroupEdit',
        'restore'
      ] as const;
      const spies = methods.map((method) => {
        const original: (
          ...args: number[]
        ) => number | string | boolean | void = proto[method];
        return vi.spyOn(proto, method).mockImplementation(function (
          this: RemusKernel,
          ...args: number[]
        ) {
          const t = performance.now();
          try {
            return original.apply(this, args);
          } finally {
            calls.push({ method, args, ms: performance.now() - t });
          }
        });
      });
      try {
        const base = withoutDerivedProjection(
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
        const initial = await adapter.syncDocument(base);
        const id = initial.exportableBodyIds[0]!;
        const body = initial.bodyRepresentations[id]!;
        const face = body.topology!.faces.find((f) =>
          kind === 'blend'
            ? f.geometry?.radius === 4 &&
              Math.abs(f.geometry.axisEnd!.y - f.geometry.axisStart!.y) > 5
            : f.geometry?.radius === 6
        )!;
        const candidate = (r: number) =>
          directEditBody(base, {
            name: 'Prepared edit',
            targetBodyId: id,
            operation:
              kind === 'blend'
                ? blend(face, r)
                : {
                    kind: 'resize-cylindrical-face',
                    faceHash: face.hash,
                    faceReference: face.reference,
                    sourceRadius: 6,
                    sourceAxisStart: face.geometry!.axisStart!,
                    sourceAxisEnd: face.geometry!.axisEnd!,
                    concavity: 'boss',
                    radius: r
                  }
          }).document;
        // Reuse one feature identity as the app's live preview does.
        const first = candidate(kind === 'blend' ? 3.5 : 6.2);
        const feature = listFeaturesInOrder(first).at(-1)!;
        const next = (r: number) => {
          if (feature.data.featureKind !== 'direct-edit')
            throw new Error('Missing direct edit');
          const op = feature.data.operation;
          if (
            op.kind !== 'resize-blend' &&
            op.kind !== 'resize-cylindrical-face'
          )
            throw new Error('Unexpected direct edit');
          return updateFeature(first, {
            featureId: feature.featureId,
            data: {
              operation:
                op.kind === 'resize-blend'
                  ? { ...op, newRadius: r }
                  : { ...op, radius: r }
            }
          });
        };
        calls.length = 0;
        for (const r of kind === 'blend' ? [3.5, 3, 2.5] : [6.2, 6.5, 7.3]) {
          const preview = await adapter.previewGeometry(next(r), {
            deferTopology: true
          });
          expect(
            preview.warnings.filter((w) => !w.startsWith('Feature "Fillet":'))
          ).toEqual([]);
          if (kind === 'blend')
            expect(
              preview.bodyRepresentations[id]!.topology!.faces.some(
                (f) => f.geometry?.blendRadius === r
              )
            ).toBe(true);
        }
        expect(
          calls.filter(
            (c) =>
              c.method ===
              (kind === 'blend'
                ? 'prepareResizeBlend'
                : 'prepareResizeCylindricalFace')
          )
        ).toHaveLength(1);
        expect(
          calls.filter((c) => c.method === 'previewPreparedGroupEdit')
        ).toHaveLength(3);
        const canonical = await adapter.syncDocument(
          next(kind === 'blend' ? 1.9 : 7.3)
        );
        expect(
          canonical.warnings.filter((w) => !w.startsWith('Feature "Fillet":'))
        ).toEqual([]);
        expect(
          calls.some((c) => c.method === 'commitPreparedGroupEditJournaled')
        ).toBe(true);
        expect(
          calls.filter((c) => c.method === 'releasePreparedGroupEdit')
        ).toHaveLength(1);
        expect(
          canonical.bodyRepresentations[id]!.topology!.faces.some(
            (f) =>
              Math.abs(
                (f.geometry?.radius ?? 0) - (kind === 'blend' ? 1.9 : 7.3)
              ) < 1e-6
          )
        ).toBe(true);
        // Drag quality is disposable. A fresh replay (no preview history or
        // held display deflection) must publish identical canonical buffers.
        const fresh = await createExactKernelAdapter();
        try {
          // Match the normal source display anchor. A diameter edit changes
          // the nominal bounding-box tolerance, while a live session holds
          // its previous full-quality tolerance across small size changes.
          await fresh.syncDocument(base);
          const replayed = await fresh.syncDocument(
            next(kind === 'blend' ? 1.9 : 7.3)
          );
          const digest = (mesh: typeof body.mesh) =>
            createHash('sha256')
              .update(
                new Uint8Array(
                  mesh.vertices.buffer,
                  mesh.vertices.byteOffset,
                  mesh.vertices.byteLength
                )
              )
              .update(
                new Uint8Array(
                  mesh.indices.buffer,
                  mesh.indices.byteOffset,
                  mesh.indices.byteLength
                )
              )
              .digest('hex');
          expect(digest(replayed.bodyRepresentations[id]!.mesh)).toBe(
            digest(canonical.bodyRepresentations[id]!.mesh)
          );
          expect(replayed.bodyRepresentations[id]!.volume).toEqual(
            canonical.bodyRepresentations[id]!.volume
          );
        } finally {
          fresh.dispose();
        }
        await adapter.previewGeometry(next(kind === 'blend' ? 2 : 7), {
          deferTopology: true
        });
        adapter.releaseEditPreview?.();
        const restored = await adapter.syncDocument(base);
        expect(restored.bodyRepresentations[id]!.mesh).toEqual(body.mesh);
        const out =
          process.env.VIDEO_PARITY_OUT ??
          'artifacts/video-parity-phase3-round2';
        mkdirSync(out, { recursive: true });
        writeFileSync(
          join(out, `${kind}-prepared-adapter.json`),
          JSON.stringify({ calls, cancelUnchanged: true }, null, 2)
        );
      } finally {
        adapter.dispose();
        spies.forEach((s) => s.mockRestore());
      }
    },
    300_000
  );
}
function blend(face: FaceTopology, r: number) {
  const carrier = blendCarrierSnapshot(face.geometry)!;
  return {
    kind: 'resize-blend' as const,
    faceHash: face.hash,
    faceReference: face.reference,
    surfaceClass: 'cylinder' as const,
    recordedRadius: 4,
    recordedCenter: carrier.center,
    recordedAxis: carrier.axis,
    newRadius: r
  };
}
