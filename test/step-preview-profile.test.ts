import { describe, expect, it } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { BodyRepresentation, FaceTopology } from '@openzcad/shared';
import {
  stepPreviewMatcher,
  type StepPreviewProfile
} from '@openzcad/viewport';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { stepPreviewProfile } from '../apps/web/src/lib/interaction/stepPreviewProfile';
import { roundedPlateDocument } from './support/rounded-plate';

function side(body: BodyRepresentation, axis: 'x' | 'y', sense: 1 | -1) {
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      face.geometry.normal![axis] * sense > 0.99
  )!;
}

/** The display mesh as the viewport proxy leaves it after a push of `delta`. */
function stretched(
  body: BodyRepresentation,
  profile: StepPreviewProfile,
  delta: number
): Float32Array {
  const moves = stepPreviewMatcher(profile);
  const out = Float32Array.from(body.mesh.vertices);
  for (let i = 0; i < out.length; i += 3) {
    if (!moves(out[i]!, out[i + 1]!, out[i + 2]!)) continue;
    out[i] = out[i]! + profile.normal.x * delta;
    out[i + 1] = out[i + 1]! + profile.normal.y * delta;
    out[i + 2] = out[i + 2]! + profile.normal.z * delta;
  }
  return out;
}

/** Enclosed volume of a closed triangle mesh. */
function meshVolume(vertices: ArrayLike<number>, indices: ArrayLike<number>) {
  let six = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [
      indices[t]! * 3,
      indices[t + 1]! * 3,
      indices[t + 2]! * 3
    ];
    six +=
      vertices[a]! *
        (vertices[b + 1]! * vertices[c + 2]! -
          vertices[b + 2]! * vertices[c + 1]!) -
      vertices[a + 1]! *
        (vertices[b]! * vertices[c + 2]! - vertices[b + 2]! * vertices[c]!) +
      vertices[a + 2]! *
        (vertices[b]! * vertices[c + 1]! - vertices[b + 1]! * vertices[c]!);
  }
  return six / 6;
}

function bounds(vertices: ArrayLike<number>) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, vertices[i + k]!);
      max[k] = Math.max(max[k]!, vertices[i + k]!);
    }
  return { min, max };
}

describe('whole-body step previews for planar face offsets', () => {
  it.each([
    { axis: 'x' as const, sense: 1 as const, delta: 15 },
    { axis: 'x' as const, sense: -1 as const, delta: 6 },
    { axis: 'y' as const, sense: 1 as const, delta: -3 },
    { axis: 'y' as const, sense: -1 as const, delta: 8 }
  ])(
    'moves the side with its corner rounds and matches the exact offset (%o)',
    async ({ axis, sense, delta }) => {
      const adapter = await createExactKernelAdapter();
      try {
        const fixture = await roundedPlateDocument();
        const derived = await adapter.syncDocument(fixture.document);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[fixture.bodyId]!;
        const face: FaceTopology = side(body, axis, sense);
        const profile = stepPreviewProfile(body, face);
        expect(profile).not.toBeNull();
        // The R5 rounds travel with the side instead of stretching out of
        // round; the push stops before the side's moved arcs meet the hole.
        expect(profile!.reach).toBe(Infinity);
        expect(profile!.span).toBeGreaterThan(Math.abs(delta));

        const preview = stretched(body, profile!, delta);
        const document = { ...fixture.document, derived };
        const plan = planFaceOffset({
          document,
          bodyId: fixture.bodyId,
          face,
          faceHash: face.hash,
          offset: delta
        })!;
        expect(plan.kind).toBe('direct-edit');
        const after = await adapter.syncDocument(plan.command.apply(document));
        expect(after.warnings).toEqual([]);
        const exact = after.bodyRepresentations[fixture.bodyId]!;

        const box = bounds(preview);
        const k = axis === 'x' ? 0 : 1;
        expect(box.min[k]).toBeCloseTo(exact.bbox.min[axis], 4);
        expect(box.max[k]).toBeCloseTo(exact.bbox.max[axis], 4);
        // Stretching straight walls is exact, so the preview gains what the
        // kernel gains, up to the display tessellation's own error.
        const gained =
          meshVolume(preview, body.mesh.indices) -
          meshVolume(body.mesh.vertices, body.mesh.indices);
        expect(gained).toBeCloseTo(exact.volume - body.volume, 1);
      } finally {
        adapter.dispose();
      }
    },
    60_000
  );

  it('keeps a hole beside the side in place and stops the push short of it', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const fixture = await roundedPlateDocument({ edgeHoleX: 76 });
      const derived = await adapter.syncDocument(fixture.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[fixture.bodyId]!;
      const face = side(body, 'x', 1);
      const profile = stepPreviewProfile(body, face)!;
      expect(profile).not.toBeNull();
      // The top and bottom stretch between the side and the Ø2 hole, whose
      // rim is 3 mm in: some of their triangles fold before then, so the
      // viewport triangulates them afresh past that point.
      const caps = profile.planarFaces!.filter(
        (face) => Math.abs(face.normal.z) > 0.99
      );
      expect(caps).toHaveLength(2);
      for (const cap of caps) {
        expect(cap.push).toBeGreaterThan(0);
        expect(cap.push).toBeLessThanOrEqual(3 + 1e-3);
      }
      const document = { ...fixture.document, derived };
      const plan = planFaceOffset({
        document,
        bodyId: fixture.bodyId,
        face,
        faceHash: face.hash,
        offset: 4
      })!;
      const after = await adapter.syncDocument(plan.command.apply(document));
      expect(after.warnings).toEqual([]);
      const exact = after.bodyRepresentations[fixture.bodyId]!;
      const preview = stretched(body, profile, 4);
      expect(bounds(preview).max[0]).toBeCloseTo(exact.bbox.max.x, 4);
      expect(
        meshVolume(preview, body.mesh.indices) -
          meshVolume(body.mesh.vertices, body.mesh.indices)
      ).toBeCloseTo(exact.volume - body.volume, 1);
    } finally {
      adapter.dispose();
    }
  }, 60_000);

  it('moves the top cap alone and leaves the hole walls to stretch', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const fixture = await roundedPlateDocument();
      const derived = await adapter.syncDocument(fixture.document);
      const body = derived.bodyRepresentations[fixture.bodyId]!;
      const top = body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z > 0.99
      )!;
      const profile = stepPreviewProfile(body, top);
      expect(profile).not.toBeNull();
      expect(profile!.span).toBeGreaterThan(0);
      expect(profile!.reach).toBe(Infinity);
      const preview = stretched(body, profile!, 4);
      expect(bounds(preview).max[2]).toBeCloseTo(10, 4);
      expect(bounds(preview).min[2]).toBeCloseTo(0, 4);
    } finally {
      adapter.dispose();
    }
  }, 60_000);
});
