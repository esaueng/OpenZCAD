import { describe, expect, it } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { BodyRepresentation } from '@openzcad/shared';
import { capPreviewProfile } from '../apps/web/src/lib/interaction/capPreviewProfile';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { steppedCylinderDocument } from './support/stepped-cylinder';

function cap(body: BodyRepresentation, axis: 'x' | 'z', sense: number) {
  return body
    .topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal![axis] * sense > 0.99
    )
    .sort(
      (a, b) => sense * (b.geometry!.center[axis] - a.geometry!.center[axis])
    )[0]!;
}

describe('terminal circular cap previews', () => {
  it.each([false, true])(
    'recognizes both ends, preserving the shoulder and exact offset semantics (tilted=%s)',
    async (tilted) => {
      const adapter = await createExactKernelAdapter();
      try {
        const fixture = await steppedCylinderDocument(tilted);
        const derived = await adapter.syncDocument(fixture.document);
        expect(derived.warnings).toEqual([]);
        const document = { ...fixture.document, derived };
        const body = derived.bodyRepresentations[fixture.bodyId]!;
        const axis = tilted ? 'x' : 'z';
        expect(body.topology!.faces).toHaveLength(9);
        for (const sense of [1, -1]) {
          const face = cap(body, axis, sense);
          const profile = capPreviewProfile(body, face);
          expect(profile).not.toBeNull();
          expect(profile!.axisStart[axis]).toBeCloseTo(
            (tilted ? 40 : 0) + sense,
            5
          );
          expect(profile!.axisEnd[axis]).toBeCloseTo(
            (tilted ? 40 : 0) + (sense === 1 ? 25 : -13),
            5
          );
          const plan = planFaceOffset({
            document,
            bodyId: fixture.bodyId,
            face,
            faceHash: face.hash,
            offset: 3
          })!;
          expect(plan.kind).toBe('direct-edit');
          const after = await adapter.syncDocument(
            plan.command.apply(document)
          );
          expect(after.warnings).toEqual([]);
          const edited = after.bodyRepresentations[fixture.bodyId]!;
          expect(edited.volume - body.volume).toBeCloseTo(
            Math.PI * (sense === 1 ? 9 : 5) ** 2 * 3,
            4
          );
          const fixed = sense === 1 ? 'min' : 'max',
            moving = sense === 1 ? 'max' : 'min';
          expect(edited.bbox[fixed][axis]).toBeCloseTo(
            body.bbox[fixed][axis],
            5
          );
          expect(edited.bbox[moving][axis]).toBeCloseTo(
            body.bbox[moving][axis] + sense * 3,
            5
          );
          expect(
            capPreviewProfile(edited, cap(edited, axis, sense))
          ).not.toBeNull();
        }
      } finally {
        adapter.dispose();
      }
    },
    60_000
  );

  it('declines shoulders, incomplete/holed walls, extra moving geometry and invalid topology', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const fixture = await steppedCylinderDocument();
      const derived = await adapter.syncDocument(fixture.document);
      const body = derived.bodyRepresentations[fixture.bodyId]!;
      const face = cap(body, 'z', 1);
      const shoulder = body.topology!.faces.find(
        (f) =>
          f.geometry?.surfaceType === 'plane' &&
          Math.abs(f.geometry.center.z) < 1e-6
      )!;
      expect(capPreviewProfile(body, shoulder)).toBeNull();
      for (const change of [
        'cap-hole',
        'wall-hole',
        'extra-face',
        'missing-triangles',
        'partial-wall',
        'off-axis-rim',
        'stale-face',
        'mesh-only'
      ] as const) {
        const copy = structuredClone(body);
        const selected = copy.topology!.faces.find(
          (f) => f.hash === face.hash
        )!;
        const wall = copy.topology!.faces.find(
          (f) => f.geometry?.radius === 9
        )!;
        if (change === 'cap-hole') selected.geometry!.area *= 0.8;
        if (change === 'wall-hole') wall.geometry!.area *= 0.8;
        if (change === 'extra-face')
          copy.topology!.faces.push({ ...wall, hash: 123 });
        if (change === 'missing-triangles') selected.triangleCount = 0;
        if (change === 'partial-wall') wall.geometry!.axisEnd!.z -= 2;
        if (change === 'off-axis-rim')
          copy.topology!.faces.find(
            (f) => f.geometry?.torusCenter?.z === 25
          )!.geometry!.torusCenter!.x += 1;
        if (change === 'mesh-only') copy.exportableStep = false;
        expect(
          capPreviewProfile(copy, change === 'stale-face' ? face : selected),
          change
        ).toBeNull();
      }
    } finally {
      adapter.dispose();
    }
  }, 60_000);
});
