import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  filletEdges,
  getLatestBodyId,
  getLatestSketchId,
  revolveSketch,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  FULL_REVOLVE_ANGLE_DEG,
  toUserId,
  type BodyRepresentation,
  type ParamValue,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * Z7 partial revolve.
 *
 * The oracle throughout is a closed form derived OUTSIDE the kernel. For a
 * profile that does not cross the axis, Pappus gives the full solid of
 * revolution as `2*pi*R_centroid*A`, and a sweep of `theta` degrees is that
 * times `theta/360` — the swept volume is linear in the angle because the
 * profile is rigid and the sweep is a rotation. Nothing here compares
 * `mass_properties` against `solid_volume`: the two share `integrate_face`,
 * so their agreement is structurally blind and has hidden three real errors
 * on this project.
 *
 * Every case also checks topology, because a correct volume over a broken
 * shell is a failure mode this project has met twice: one closed shell, zero
 * free edges, zero non-manifold edges, and `V - E + F = 2`.
 */

const PROFILE_INNER_RADIUS = 2;
const PROFILE_OUTER_RADIUS = 3;
const PROFILE_HEIGHT = 1;

/** Pappus, computed here and not read back out of the kernel. */
function fullRevolveVolume(scale: number): number {
  const width = (PROFILE_OUTER_RADIUS - PROFILE_INNER_RADIUS) * scale;
  const height = PROFILE_HEIGHT * scale;
  const centroidRadius =
    ((PROFILE_INNER_RADIUS + PROFILE_OUTER_RADIUS) / 2) * scale;
  return 2 * Math.PI * centroidRadius * (width * height);
}

function partialRevolveVolume(angleDeg: number, scale: number): number {
  return (fullRevolveVolume(scale) * angleDeg) / FULL_REVOLVE_ANGLE_DEG;
}

/**
 * `V - E + F` over the welded display mesh. Vertices are welded on the same
 * quantization `inspectTriangleMeshClosure` uses, so a mesh that reports zero
 * boundary edges is being counted the same way here.
 */
function eulerCharacteristic(mesh: {
  vertices: number[];
  indices: number[];
}): number {
  const bounds = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity
  ];
  let magnitude = 0;
  for (let index = 0; index + 2 < mesh.vertices.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.vertices[index + axis]!;
      bounds[axis] = Math.min(bounds[axis]!, value);
      bounds[axis + 3] = Math.max(bounds[axis + 3]!, value);
      magnitude = Math.max(magnitude, Math.abs(value));
    }
  }
  const extent = Math.max(
    bounds[3]! - bounds[0]!,
    bounds[4]! - bounds[1]!,
    bounds[5]! - bounds[2]!,
    0
  );
  const quantum = Math.max(1e-9, extent * 1e-6, magnitude * 2 ** -22);
  const key = (index: number): string =>
    [0, 1, 2]
      .map((axis) => Math.round(mesh.vertices[index * 3 + axis]! / quantum))
      .join(',');

  const vertices = new Set<string>();
  const edges = new Set<string>();
  let faces = 0;
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const corners = [
      key(mesh.indices[index]!),
      key(mesh.indices[index + 1]!),
      key(mesh.indices[index + 2]!)
    ];
    if (new Set(corners).size !== 3) {
      continue;
    }
    faces += 1;
    corners.forEach((corner) => vertices.add(corner));
    for (const [start, end] of [
      [corners[0]!, corners[1]!],
      [corners[1]!, corners[2]!],
      [corners[2]!, corners[0]!]
    ] as const) {
      edges.add(start < end ? `${start}|${end}` : `${end}|${start}`);
    }
  }
  return vertices.size - edges.size + faces;
}

function annulusProfile(scale: number): SketchObjectData {
  return {
    objectKind: 'rectangle',
    width: (PROFILE_OUTER_RADIUS - PROFILE_INNER_RADIUS) * scale,
    height: PROFILE_HEIGHT * scale,
    centerX: ((PROFILE_INNER_RADIUS + PROFILE_OUTER_RADIUS) / 2) * scale,
    centerY: (PROFILE_HEIGHT / 2) * scale
  };
}

function circleProfile(scale: number): SketchObjectData {
  return {
    objectKind: 'circle',
    radius: 0.5 * scale,
    centerX: 2.5 * scale,
    centerY: 0
  };
}

function documentWithRevolve(
  object: SketchObjectData,
  angleDeg: ParamValue | undefined
): ProjectDocument {
  const sketched = addSketchFeature(
    createProjectDocument('Z7', toUserId('user_test')),
    { name: 'Profile', plane: 'XZ', offset: 0, object }
  ).document;
  return revolveSketch(sketched, {
    name: 'Revolve',
    sketchId: getLatestSketchId(sketched)!,
    axis: 'vertical',
    angleDeg
  }).document;
}

let kernel: ExactKernelAdapter;

beforeAll(async () => {
  kernel = await createExactKernelAdapter();
}, 120_000);

afterAll(() => {
  kernel.dispose();
});

async function buildRevolve(
  object: SketchObjectData,
  angleDeg: ParamValue | undefined
): Promise<{
  document: ProjectDocument;
  warnings: string[];
  body: BodyRepresentation | undefined;
}> {
  const document = documentWithRevolve(object, angleDeg);
  const derived = await kernel.syncDocument(document);
  return {
    document,
    warnings: derived.warnings,
    body: derived.bodyRepresentations[getLatestBodyId(document)!]
  };
}

/**
 * `expectedEuler` is 2 for a wedge and 0 for a full turn, and the difference
 * is not a defect. Sweeping an off-axis profile a full turn closes the sweep
 * onto itself and produces a genus-1 solid; stopping short leaves the two cap
 * faces and a topological ball. Asserting 2 everywhere — as the Z7 brief did
 * — would be wrong at 360 and would have been "fixed" by loosening the check.
 */
function expectSoundSolid(
  body: BodyRepresentation,
  expectedEuler: 0 | 2
): void {
  const closure = inspectTriangleMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  expect(closure.boundaryEdges).toBe(0);
  expect(closure.nonManifoldEdges).toBe(0);
  expect(closure.inconsistentWindingEdges).toBe(0);
  expect(eulerCharacteristic(body.mesh)).toBe(expectedEuler);
}

/**
 * Signed volume of a closed triangle mesh, `(1/6) * sum a . (b x c)`. Positive
 * exactly when the winding is outward. Its magnitude carries the tessellation
 * chord error, so it is used for the SIGN only.
 */
function meshSignedVolume(mesh: {
  vertices: number[];
  indices: number[];
}): number {
  let total = 0;
  const at = (index: number, axis: number): number =>
    mesh.vertices[index * 3 + axis]!;
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const a = mesh.indices[index]!;
    const b = mesh.indices[index + 1]!;
    const c = mesh.indices[index + 2]!;
    total +=
      (at(a, 0) * (at(b, 1) * at(c, 2) - at(b, 2) * at(c, 1)) -
        at(a, 1) * (at(b, 0) * at(c, 2) - at(b, 2) * at(c, 0)) +
        at(a, 2) * (at(b, 0) * at(c, 1) - at(b, 1) * at(c, 0))) /
      6;
  }
  return total;
}

describe('partial revolve geometry', () => {
  it.each([90, 180, 270, 359, 337.5])(
    'sweeps %s degrees to the closed-form volume over one sound shell',
    async (angleDeg) => {
      const { warnings, body } = await buildRevolve(
        annulusProfile(1),
        angleDeg
      );
      expect(warnings).toEqual([]);
      expect(body).toBeDefined();
      const expected = partialRevolveVolume(angleDeg, 1);
      expect(Math.abs(body!.volume - expected)).toBeLessThan(1e-9);
      expectSoundSolid(body!, 2);
    },
    120_000
  );

  it('sweeps a full turn to the Pappus volume over a genus-1 shell', async () => {
    const { warnings, body } = await buildRevolve(
      annulusProfile(1),
      FULL_REVOLVE_ANGLE_DEG
    );
    expect(warnings).toEqual([]);
    expect(Math.abs(body!.volume - fullRevolveVolume(1))).toBeLessThan(1e-9);
    expectSoundSolid(body!, 0);
  }, 120_000);

  it('treats an absent angle as a full turn, byte-for-byte', async () => {
    const [absent, explicit] = await Promise.all([
      buildRevolve(annulusProfile(1), undefined),
      buildRevolve(annulusProfile(1), FULL_REVOLVE_ANGLE_DEG)
    ]);
    // The stored feature keeps no angle at all, so a document written before
    // this field existed cannot change shape by being reopened.
    const feature = Object.values(absent.document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'revolve'
    );
    expect(
      feature?.kind === 'feature' && feature.data.featureKind === 'revolve'
        ? feature.data.angleDeg
        : 'missing'
    ).toBeUndefined();
    expect(absent.body!.volume).toBe(explicit.body!.volume);
    expect(absent.body!.faceCount).toBe(explicit.body!.faceCount);
    expect(absent.body!.volume).toBeCloseTo(fullRevolveVolume(1), 12);
  }, 120_000);

  it.each([1, 1000])(
    'holds the closed form at scale %s',
    async (scale) => {
      const { warnings, body } = await buildRevolve(annulusProfile(scale), 90);
      expect(warnings).toEqual([]);
      const expected = partialRevolveVolume(90, scale);
      // Relative, because an absolute 1e-9 is meaningless at 1000x.
      expect(Math.abs(body!.volume - expected) / expected).toBeLessThan(1e-12);
      expectSoundSolid(body!, 2);
    },
    120_000
  );

  /**
   * CHARACTERIZATION, not an endorsement. Scale invariance fails for a
   * partial revolve at small model scales, and only for a partial revolve:
   * the same profile at 360 stays exact to 4e-16 at 1e-3, and cylinder /
   * sphere / torus primitives are exact to 1e-16 there too.
   *
   * The threshold is ANGLE-DEPENDENT, which an earlier reading of this
   * ("below roughly 5e-3 model units") got wrong. Measured:
   *
   *   scale   45deg       90deg       180deg      270deg
   *   1e-2    exact       exact       exact       exact
   *   5e-3    1.2985e-5   exact       exact       exact
   *   3e-3    1.2985e-5   exact       exact       exact
   *   2e-3    1.2985e-5   1.6967e-5   2.7593e-5   3.4452e-5
   *   1e-3    1.2985e-5   1.6967e-5   2.7593e-5   3.4452e-5
   *   5e-4    1.2985e-5   1.6967e-5   2.7593e-5   3.4452e-5
   *
   * So 45 degrees breaks at 5e-3 while the other three are still exact
   * there and only break at 2e-3. Once past its OWN threshold each angle
   * saturates at a fixed relative error, identical to five significant
   * figures across every smaller scale.
   *
   * That angle-dependence is why this is NOT the same thing as brepkit#59's
   * `Tolerance::linear / min_radius` note. That ratio is angle-independent —
   * the profile's inner radius is 2*scale whatever the sweep — so it would
   * break all four angles at the same scale. The observed pattern instead
   * fits a segment count driven by an absolute sagitta tolerance and floored
   * at a minimum: a smaller sweep needs fewer segments to meet the same
   * sagitta, so it reaches the floor sooner, at a LARGER scale. Same defect
   * class as the recurring absolute-length constants, different site.
   *
   * The error is always LOW, consistent with a chord under-approximation of
   * the swept arc. This test exists so the numbers cannot drift unnoticed
   * and so nobody "fixes" it by loosening the 1x and 1000x cases above.
   */
  it.each([
    [90, 1.6967e-5],
    [270, 3.4452e-5]
  ])(
    'records the small-scale volume error at 0.001x and %s degrees',
    async (angleDeg, expectedRelativeError) => {
      const { warnings, body } = await buildRevolve(
        annulusProfile(0.001),
        angleDeg
      );
      expect(warnings).toEqual([]);
      const expected = partialRevolveVolume(angleDeg, 0.001);
      const relative = (expected - body!.volume) / expected;
      expect(relative).toBeGreaterThan(0);
      expect(relative).toBeCloseTo(expectedRelativeError, 8);
      // The shell is still sound; it is the measurement that drifts.
      expectSoundSolid(body!, 2);
    },
    120_000
  );

  it('keeps the full revolve exact at 0.001x, where the wedge is not', async () => {
    const { body } = await buildRevolve(annulusProfile(0.001), 360);
    const expected = fullRevolveVolume(0.001);
    expect(Math.abs(body!.volume - expected) / expected).toBeLessThan(1e-12);
  }, 120_000);

  it.each([0, -1, 360.0001, 400])(
    'refuses %s as an out-of-range angle',
    async (angleDeg) => {
      const { warnings, body } = await buildRevolve(
        annulusProfile(1),
        angleDeg
      );
      expect(warnings).toEqual([
        'Feature "Revolve": Revolve angle must be greater than 0 and at most 360 degrees.'
      ]);
      expect(body).toBeUndefined();
    },
    120_000
  );

  it('accepts the exact upper end of the (0, 360] domain', async () => {
    const { warnings, body } = await buildRevolve(annulusProfile(1), 360);
    expect(warnings).toEqual([]);
    expect(body).toBeDefined();
  }, 120_000);

  it('reports a non-finite angle through the parameter layer', async () => {
    const { warnings, body } = await buildRevolve(
      annulusProfile(1),
      Number.NaN
    );
    expect(warnings).toEqual([
      'Feature "Revolve": angle: value is not finite.'
    ]);
    expect(body).toBeUndefined();
  }, 120_000);

  it('resolves the angle through the parameter table', async () => {
    const parameterized = setParameter(
      createProjectDocument('Z7', toUserId('user_test')),
      { name: 'sweep', expression: '45 * 2' }
    );
    const sketched = addSketchFeature(parameterized, {
      name: 'Profile',
      plane: 'XZ',
      offset: 0,
      object: annulusProfile(1)
    }).document;
    const document = revolveSketch(sketched, {
      name: 'Revolve',
      sketchId: getLatestSketchId(sketched)!,
      axis: 'vertical',
      angleDeg: 'sweep'
    }).document;
    const derived = await kernel.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[getLatestBodyId(document)!]!;
    expect(Math.abs(body.volume - partialRevolveVolume(90, 1))).toBeLessThan(
      1e-9
    );
  }, 120_000);
});

describe('partial revolve lineage', () => {
  it('keeps full ADR-013 semantic lineage at a full turn', async () => {
    const { body } = await buildRevolve(annulusProfile(1), 360);
    // The regression that would matter most: a full revolve must be exactly
    // what it was before the angle existed.
    expect(body!.faceCount).toBe(4);
    expect(body!.topology!.lineageDiagnostics ?? []).toEqual([]);
    // All four swept faces carry a name, and so does the circular edge swept
    // by each of the rectangle's four vertices. The two straight seam edges
    // have never had a role, at any angle, and still do not — this asserts
    // the pre-existing set exactly rather than "all of them".
    const suffix = (name: string): string =>
      name.replace(/\.ent_[0-9a-f-]+\./, '.');
    expect(
      body!
        .topology!.faces.map((face) => suffix(face.reference!.lineageName))
        .sort()
    ).toEqual([
      'sweep.face.side.0',
      'sweep.face.side.1',
      'sweep.face.side.2',
      'sweep.face.side.3'
    ]);
    expect(
      body!
        .topology!.edges.map((edge) =>
          edge.reference
            ? suffix(edge.reference.lineageName)
            : `${edge.curve!.type}:unnamed`
        )
        .sort()
    ).toEqual([
      'LINE:unnamed',
      'LINE:unnamed',
      'sweep.edge.profile.vertex.0',
      'sweep.edge.profile.vertex.1',
      'sweep.edge.profile.vertex.2',
      'sweep.edge.profile.vertex.3'
    ]);
  }, 120_000);

  it('falls back to hash-only below a full turn, and says why', async () => {
    const { body } = await buildRevolve(annulusProfile(1), 90);
    expect(body!.topology!.faces.some((face) => face.reference)).toBe(false);
    expect(body!.topology!.edges.some((edge) => edge.reference)).toBe(false);
    const diagnostics = body!.topology!.lineageDiagnostics ?? [];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.status).toBe('hash-only');
    // The requirement is that the fallback is DELIBERATE and legible, not
    // that it is a silent absence of matches. Both measured causes are named.
    expect(diagnostics[0]!.message).toContain('by design');
    expect(diagnostics[0]!.message).toContain('arcs');
    expect(diagnostics[0]!.message).toContain('90 degree boundaries');
  }, 120_000);

  it.each([90, 180, 270, 359])(
    'still publishes a resolvable hash for every face and edge at %s degrees',
    async (angleDeg) => {
      const { body } = await buildRevolve(annulusProfile(1), angleDeg);
      const hashes = body!.topology!.edges.map((edge) => edge.hash);
      expect(new Set(hashes).size).toBe(hashes.length);
      expect(hashes.every((hash) => Number.isInteger(hash) && hash > 0)).toBe(
        true
      );
    },
    120_000
  );

  it('reproduces the measured quadrant split the fallback exists for', async () => {
    // 6 / 10 / 14 / 18 / 4. If this ever changes, the second reason in
    // PARTIAL_REVOLVE_HASH_ONLY_REASON needs re-measuring, not re-asserting.
    const counts = await Promise.all(
      [90, 180, 270, 359, 360].map(async (angleDeg) => {
        const { body } = await buildRevolve(annulusProfile(1), angleDeg);
        return body!.faceCount;
      })
    );
    expect(counts).toEqual([6, 10, 14, 18, 4]);
  }, 240_000);

  it('exempts a circular profile: a torus does not quadrant-split', async () => {
    for (const angleDeg of [90, 180, 270, 359, 360]) {
      const { warnings, body } = await buildRevolve(circleProfile(1), angleDeg);
      expect(warnings).toEqual([]);
      // One torus face at a full turn; the torus plus two caps below it. The
      // torus is never split, which is what keeps its role unique.
      expect(body!.faceCount).toBe(angleDeg === 360 ? 1 : 3);
      const named = body!.topology!.faces.filter((face) => face.reference);
      expect(named).toHaveLength(1);
      expect(named[0]!.reference!.lineageName).toMatch(
        /^sweep\.face\.side\..*\.circle$/
      );
      expect(body!.topology!.lineageDiagnostics ?? []).toEqual([]);
      expectSoundSolid(body!, angleDeg === 360 ? 0 : 2);
    }
  }, 240_000);
});

describe('partial revolve mesh orientation', () => {
  /**
   * These six were written as a CHARACTERIZATION of an open defect: BrepKit's
   * `revolve` returned a reversed shell below a full turn, so the display
   * mesh and the exported STL both came out inside-out. `writeAsciiStl`
   * computes facet normals from the winding, so a wedge exported with every
   * normal pointing into the solid.
   *
   * brepkit#59 fixed it, and these were FLIPPED rather than relaxed — the
   * assertion is now stronger than the sign test it replaced. Two corrections
   * that PR established, kept here because they explain the shape of the
   * fix:
   *
   * - It was never partial-only. The predictor is the sign of
   *   `input_normal . (axis x e_r)`, not the sweep angle, so half the
   *   configuration space was already outward — which is why sampling made it
   *   look intermittent.
   * - The 360 case was not correct either; it just usually took a different
   *   path. A holed profile defers both fast paths and reproduced the
   *   reversal at a full turn too.
   *
   * Why a green suite hid this for so long: `solid_volume` returns the
   * MAGNITUDE of its integral, so an inside-out solid still reports a
   * correct, positive volume. Only the winding could see it — hence a signed
   * mesh volume rather than `body.volume`.
   */
  it.each([45, 90, 180, 270, 359, 359.99])(
    'winds an outward mesh enclosing the swept volume at %s degrees',
    async (angleDeg) => {
      const { body } = await buildRevolve(annulusProfile(1), angleDeg);
      const signed = meshSignedVolume(body!.mesh);
      // Outward, which is the whole point of #59.
      expect(signed).toBeGreaterThan(0);
      // And it encloses the RIGHT volume, not merely a positive one. A sign
      // flip alone would pass a mesh that was outward-wound and wrong; this
      // is the Pappus closed form the file already computes by hand.
      const expected = partialRevolveVolume(angleDeg, 1);
      expect(Math.abs(signed - expected) / expected).toBeLessThan(5e-4);
      // The display mesh is inscribed, so it must come in slightly UNDER the
      // exact swept volume rather than straddling it.
      expect(signed).toBeLessThan(expected);
    },
    120_000
  );

  it('winds a full turn outward, as everything else does', async () => {
    const { body } = await buildRevolve(annulusProfile(1), 360);
    expect(meshSignedVolume(body!.mesh)).toBeGreaterThan(0);
  }, 120_000);
});

describe('partial revolve and edge modifiers', () => {
  it('explains a fillet refusal on a wedge instead of advising a smaller radius', async () => {
    const { document, body } = await buildRevolve(annulusProfile(1), 90);
    const bodyId = getLatestBodyId(document)!;
    const edges = body!.topology!.edges;
    expect(edges).toHaveLength(12);

    const outcomes = await Promise.all(
      edges.map(async (edge) => {
        const candidate = filletEdges(document, {
          name: 'Round',
          targetBodyId: bodyId,
          edgeHashes: [edge.hash],
          size: 0.1
        }).document;
        return (await kernel.syncDocument(candidate)).warnings;
      })
    );

    // Every wedge edge refuses. The volume-envelope guard below the kernel
    // catches the two that once returned a doubled body instead.
    const refused = outcomes.filter((warnings) => warnings.length === 1);
    expect(refused).toHaveLength(12);
    // Every refusal still names the wedge. In particular none says "try a
    // smaller radius", which is false at every radius here, and none says the
    // edge no longer exists, which it does.
    for (const warnings of refused) {
      expect(warnings[0]).toContain('This body is a partial revolve');
      expect(warnings[0]).not.toContain('Try a smaller radius');
      expect(warnings[0]).not.toContain('no longer exists');
    }
  }, 300_000);

  /** The latest kernel must refuse or return a plausibly sized blend. */
  it('never publishes the doubled wedge body', async () => {
    const { document, body } = await buildRevolve(annulusProfile(1), 90);
    const bodyId = getLatestBodyId(document)!;
    const edges = body!.topology!.edges;
    // 5*pi/4, the exact quarter-turn Pappus volume, stated by hand.
    const WEDGE = (5 * Math.PI) / 4;
    expect(Math.abs(body!.volume - WEDGE)).toBeLessThan(1e-9);

    let refused = 0;
    for (const edge of edges) {
      const candidate = filletEdges(document, {
        name: 'Round',
        targetBodyId: bodyId,
        edgeHashes: [edge.hash],
        size: 0.1
      }).document;
      const derived = await kernel.syncDocument(candidate);
      const resultId = getLatestBodyId(candidate)!;
      if (derived.warnings.length > 0) {
        refused += 1;
        expect(derived.warnings).toHaveLength(1);
        expect(derived.warnings[0]).toContain('This body is a partial revolve');
        expect(derived.bodyRepresentations[resultId]).toBeUndefined();
        expect(derived.bodyRepresentations[bodyId]!.consumed).toBe(false);
        expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          WEDGE,
          9
        );
      } else {
        const filleted = derived.bodyRepresentations[resultId]!;
        expect(filleted.volume / WEDGE).toBeGreaterThan(0.9);
        expect(filleted.volume / WEDGE).toBeLessThan(1.1);
      }
    }
    expect(refused).toBeGreaterThanOrEqual(10);
  }, 300_000);

  it('leaves the full revolve able to round four of its six edges', async () => {
    const { document, body } = await buildRevolve(annulusProfile(1), 360);
    const bodyId = getLatestBodyId(document)!;
    const edges = body!.topology!.edges;
    expect(edges).toHaveLength(6);
    const accepted = await Promise.all(
      edges.map(async (edge) => {
        const candidate = filletEdges(document, {
          name: 'Round',
          targetBodyId: bodyId,
          edgeHashes: [edge.hash],
          size: 0.1
        }).document;
        return (await kernel.syncDocument(candidate)).warnings.length === 0;
      })
    );
    expect(accepted.filter(Boolean)).toHaveLength(4);
  }, 300_000);
});
