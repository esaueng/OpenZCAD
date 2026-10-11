import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  helicalSweepProfile
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type SketchObjectData } from '@openzcad/shared';
import { sweepFacetingAdvisories } from '../apps/web/src/lib/sweepFaceting';
import {
  ELBOW_FACES,
  ELBOW_VOLUME,
  elbowPath,
  profileSketch,
  roundProfile,
  sweptAlong
} from './fixtures/swept-elbow';

/**
 * Production QA CAD-003 (2026-10-11): curved round-profile sweeps came back as
 * flat facets with no disclosure. A circle r = 3 swept 270° about r = 30 was
 * 902 planes in Standard and Smooth alike (−2.16% against the exact torus
 * segment), and a helical spring was planes and bilinear patches. Geometry is
 * unchanged here; what changes is that Diagnostics now says so, with the
 * curved-profile disclosure, and says when Smooth could not apply.
 */
const user = toUserId('user_sweep_faceting');
const circle = roundProfile(3);
const square: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 0,
  centerY: 0
};

describe('faceted sweep disclosure', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  async function sweep(
    profile: SketchObjectData,
    path: SketchObjectData,
    mode: 'standard' | 'smooth'
  ) {
    const swept = sweptAlong(profile, path, mode);
    const derived = await adapter.syncDocument(swept.document);
    return { document: { ...swept.document, derived }, bodyId: swept.bodyId };
  }

  it('discloses the QA elbow as facets, without an unproven cap-area figure, and leaves it unchanged', async () => {
    for (const mode of ['standard', 'smooth'] as const) {
      const { document, bodyId } = await sweep(circle, elbowPath, mode);
      const body = document.derived.bodyRepresentations[bodyId]!;
      // Unchanged geometry: the body the QA run measured.
      expect(document.derived.warnings).toEqual([]);
      expect(body.faceCount).toBe(ELBOW_FACES);
      expect(body.volume).toBeCloseTo(ELBOW_VOLUME, 3);

      const [advisory, ...rest] = sweepFacetingAdvisories(document);
      expect(rest).toEqual([]);
      expect(advisory?.message).not.toContain('end caps measure');
      expect(advisory).toMatchObject({ featureName: 'Bend', kind: 'advisory' });
      expect(advisory!.message).toBe(
        'Feature "Bend": This sweep is a faceted approximation, not exact curved surfaces: its curved path is followed in straight steps, and the profile\'s curved edges become straight chords. Its 902 faces are what its volume, mass and STEP export measure.' +
          (mode === 'smooth'
            ? ' Smooth only samples a path of one line or one arc of up to a quarter turn more finely; this path is built from 3 edges, so Smooth built the same body as Standard.'
            : '')
      );
    }
  });

  it('uses active preview topology and does not mistake a similar-area wall for a cap', async () => {
    const { document, bodyId } = await sweep(circle, elbowPath, 'standard');
    const shown = document.derived.bodyRepresentations[bodyId]!;
    const faces = shown.topology!.faces.map((face) => ({
      ...face,
      geometry: face.geometry
        ? { ...face.geometry, area: Math.PI * 9 * 0.999 }
        : undefined
    }));
    const active = { ...shown, topology: { ...shown.topology!, faces } };
    // The completed document has no bodies during staged analysis.
    document.derived.bodyRepresentations = {};
    expect(sweepFacetingAdvisories(document)).toEqual([]);
    const [advisory] = sweepFacetingAdvisories(document, { [bodyId]: active });
    expect(advisory?.message).toContain('faceted approximation');
    expect(advisory?.message).toContain('straight chords');
    expect(advisory?.message).not.toContain('%');
  });

  it('discloses a straight-edged profile on a curved path without a cap figure', async () => {
    const { document } = await sweep(square, elbowPath, 'standard');
    const [advisory] = sweepFacetingAdvisories(document);
    expect(advisory?.message).toContain(
      'its curved path is followed in straight steps.'
    );
    expect(advisory?.message).not.toContain('chords');
  });

  it('raises nothing for a circle swept along a straight line, which stays exact', async () => {
    const { document, bodyId } = await sweep(
      circle,
      { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 },
      'smooth'
    );
    const faces = document.derived.bodyRepresentations[bodyId]!.topology!.faces;
    expect(faces.map((face) => face.geometry?.surfaceType).sort()).toEqual([
      'cylinder',
      'plane',
      'plane'
    ]);
    expect(sweepFacetingAdvisories(document)).toEqual([]);
  });

  it('discloses a round-wire helical spring, chords included', async () => {
    const start = profileSketch(createProjectDocument('Spring', user), {
      objectKind: 'circle',
      radius: 2,
      centerX: 0,
      centerY: 0
    });
    const helical = helicalSweepProfile(start.document, {
      name: 'Spring',
      profile: start.section,
      axisOrigin: { x: 0, y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 },
      radius: 18,
      pitch: 8,
      turns: 1
    });
    const derived = await adapter.syncDocument(helical.document);
    expect(derived.warnings).toEqual([]);
    const [advisory] = sweepFacetingAdvisories({
      ...helical.document,
      derived
    });
    expect(advisory?.message).toMatch(
      /^Feature "Spring": This helical sweep is a faceted approximation, not exact curved surfaces: its curved path is followed in straight steps, and the profile's curved edges become straight chords\. Its \d+ faces are what its volume, mass and STEP export measure\.$/
    );
  });
});
