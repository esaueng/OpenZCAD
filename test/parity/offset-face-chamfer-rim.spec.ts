/**
 * Offsetting a face whose rim is chamfered carries the chamfer.
 *
 * Production QA: a body with rounded vertical corners and a 0.7 chamfer
 * round its bottom edge could not offset the bottom face at any distance.
 * The pinned kernel's move treats the chamfer faces as neighbours to
 * re-limit, and the cones over the rounded corners either run into their
 * apex (outward) or the face sweeps into the walls (inward). On a
 * sharp-cornered body the same move "succeeds" by extending the chamfer
 * planes: pushing the bottom in grew the body sideways
 * (esaueng/remus#1957). The adapter now slides the cap and its chamfer band
 * along the walls in the native arena.
 *
 * The bodies are built the way a user builds them (box, rounds, chamfer),
 * because only a band matching a chamfer in the history is carried: the
 * same shape as a drafted section keeps the kernel's re-limiting move.
 *
 * A STEP import has no history, so its chamfer-shaped band keeps that move
 * too; the adapter refuses, typed, the results that are wrong whether the
 * band is a chamfer or a draft (pushed past the band's top, the base came
 * out wider than the walls; pulled until the tilted faces cross, it turned
 * inside out).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  filletEdges,
  importStepBody,
  normalizeDocument
} from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toFeatureId,
  toUserId,
  type BodyId,
  type EdgeTopology,
  type FaceTopology,
  type FeatureWarning,
  type OffsetRimPolicy,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import {
  chamferSetbacksBefore,
  guardUncarriedChamferBand,
  tryCarryChamferRim
} from '../../packages/kernel-adapter/src/exact-chamfer-rim-carry';

const X = 60;
const Y = 40;
const Z = 20;
const ROUND = 3;
const CHAMFER = 0.35;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Every point of the edge's display polyline satisfies `keep`. */
const along =
  (keep: (x: number, y: number, z: number) => boolean) =>
  (edge: EdgeTopology) => {
    const p = edge.points;
    for (let i = 0; i < p.length; i += 3) {
      if (!keep(p[i]!, p[i + 1]!, p[i + 2]!)) return false;
    }
    return p.length > 0;
  };
const onBottom = along((_x, _y, z) => near(z, 0));
const vertical = (edge: EdgeTopology) =>
  along((x, y) => near(x, edge.points[0]!) && near(y, edge.points[1]!))(edge) &&
  (edge.length ?? 0) > Z / 2;

interface Fixture {
  document: ProjectDocument;
  bodyId: BodyId;
  bottom: FaceTopology;
  volume: number;
  /** The wall cross-section. */
  section: number;
}

describe('offset face ringed by a chamfer', { timeout: 300_000 }, () => {
  let adapter: RemusKernelAdapter;
  const fixtures = new Map<string, Fixture>();

  async function edgesOf(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[bodyId]!.topology!.edges;
  }

  async function chamfered(
    name: string,
    options: {
      round?: boolean;
      pick?: (edge: EdgeTopology) => boolean;
      distance2?: number;
    }
  ): Promise<Fixture> {
    let document = addPrimitiveFeature(
      createProjectDocument(name, toUserId('user_chamfer_rim')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: X, height: Y, depth: Z }
      }
    );
    let bodyId = document.bodyOrder[0]!;
    if (options.round) {
      const verticals = (await edgesOf(document, bodyId)).filter(vertical);
      expect(verticals).toHaveLength(4);
      const rounded = filletEdges(document, {
        name: 'Corners',
        targetBodyId: bodyId,
        edgeHashes: verticals.map((edge) => edge.hash),
        edgeReferences: verticals.map((edge) => edge.reference!),
        size: ROUND
      });
      document = rounded.document;
      bodyId = rounded.bodyId;
    }
    const rim = (await edgesOf(document, bodyId)).filter(
      (edge) => onBottom(edge) && (options.pick?.(edge) ?? true)
    );
    expect(rim.length).toBeGreaterThan(0);
    const result = chamferEdges(document, {
      name: 'Chamfer',
      targetBodyId: bodyId,
      edgeHashes: rim.map((edge) => edge.hash),
      edgeReferences: rim.map((edge) => edge.reference!),
      size: CHAMFER,
      ...(options.distance2 === undefined
        ? {}
        : { distance2: options.distance2 })
    });
    const derived = await adapter.syncDocument(result.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[result.bodyId]!;
    const bottom = body
      .topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z < -0.999
      )
      .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
    return {
      document: result.document,
      bodyId: result.bodyId,
      bottom,
      volume: body.volume,
      section: options.round ? X * Y - (4 - Math.PI) * ROUND * ROUND : X * Y
    };
  }

  beforeAll(async () => {
    adapter = new RemusKernelAdapter();
    fixtures.set('rounded', await chamfered('rounded', { round: true }));
    fixtures.set('sharp', await chamfered('sharp', {}));
    // Only the front bottom edge: the kernel's move built a body 1.65
    // deeper and ~29000 mm³ too small when pushed in by 2.
    fixtures.set(
      'one-edge',
      await chamfered('one-edge', {
        pick: along((_x, y) => near(y, 0))
      })
    );
    fixtures.set(
      'uneven',
      await chamfered('uneven', { round: true, distance2: 2 * CHAMFER })
    );
  });

  afterAll(() => {
    adapter.dispose();
  });

  function offsetBy(
    f: Fixture,
    offset: number,
    policy: OffsetRimPolicy | 'historical' = 'historical'
  ): ProjectDocument {
    const input = {
      name: 'Offset Face',
      targetBodyId: f.bodyId,
      operation: {
        kind: 'offset-face' as const,
        faceHash: f.bottom.hash,
        ...(f.bottom.reference ? { faceReference: f.bottom.reference } : {}),
        sourceSurfaceType: 'plane' as const,
        sourceArea: f.bottom.geometry!.area,
        sourceCenter: f.bottom.geometry!.center,
        sourceNormal: f.bottom.geometry!.normal!,
        offset,
        ...(policy === 'historical' || policy === 'refuse'
          ? {}
          : { ambiguousRim: policy })
      }
    };
    return policy === 'historical'
      ? directEditBody(f.document, input, 'replay').document
      : commandFactories.directEditBody(input).apply(f.document);
  }

  function failures(warnings: readonly FeatureWarning[] | undefined) {
    return (warnings ?? []).filter(
      (warning) =>
        warning.featureName === 'Offset Face' &&
        (warning.kind === 'build-failed' || warning.kind === 'refusal')
    );
  }

  it('carries an authored rim after an unrelated body is added', async () => {
    const fixture = fixtures.get('sharp')!;
    const document = addPrimitiveFeature(fixture.document, {
      name: 'Separate box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const state = await adapter.syncDocument(
      offsetBy({ ...fixture, document }, 2, 'refuse')
    );
    expect(failures(state.featureWarnings)).toEqual([]);
    expect(
      state.bodyRepresentations[fixture.bodyId]!.volume - fixture.volume
    ).toBeCloseTo(2 * X * Y, 5);
  });

  for (const shape of ['rounded', 'sharp', 'one-edge', 'uneven'] as const) {
    for (const offset of [20, 2, 0.1, -0.1, -2, -12]) {
      it(`${shape}: carries the chamfer through an offset of ${offset}`, async () => {
        const f = fixtures.get(shape)!;
        const candidate = offsetBy(f, offset, 'refuse');
        const preview = await adapter.previewGeometry(candidate, {
          deferTopology: true
        });
        expect(failures(preview.featureWarnings)).toEqual([]);
        const committed = await adapter.syncDocument(candidate);
        expect(failures(committed.featureWarnings)).toEqual([]);
        const body = Object.values(committed.bodyRepresentations).at(-1)!;
        // The walls keep their footprint; only the bottom moves.
        expect(body.bbox.min.x).toBeCloseTo(0, 6);
        expect(body.bbox.max.x).toBeCloseTo(X, 6);
        expect(body.bbox.min.y).toBeCloseTo(0, 6);
        expect(body.bbox.max.y).toBeCloseTo(Y, 6);
        expect(body.bbox.min.z).toBeCloseTo(-offset, 6);
        expect(body.bbox.max.z).toBeCloseTo(Z, 6);
        // The chamfer is carried, not stretched: exactly the swept prism.
        expect(body.volume).toBeCloseTo(f.volume + offset * f.section, 2);
        // The moved face keeps the chamfer's inset: same area as before.
        const moved = body.topology!.faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            face.geometry.normal!.z < -0.999
        );
        expect(moved).toHaveLength(1);
        expect(moved[0]!.geometry!.area).toBeCloseTo(
          f.bottom.geometry!.area,
          6
        );
      });
    }
  }

  for (const [shape, offset] of [
    // Past the top of the walls: nothing is left to carry the chamfer on.
    ['rounded', -Z],
    ['sharp', -(Z - CHAMFER / 2)]
  ] as const) {
    it(`${shape}: refuses ${offset} as a chamfer it cannot carry`, async () => {
      const f = fixtures.get(shape)!;
      const candidate = offsetBy(f, offset, 'refuse');
      for (const derived of [
        await adapter.previewGeometry(candidate, { deferTopology: true }),
        await adapter.syncDocument(candidate)
      ]) {
        const [refusal] = failures(derived.featureWarnings);
        expect(refusal, 'the offset is refused').toBeDefined();
        expect(refusal!.kernelRefusal).toMatchObject({
          family: 'direct-edit',
          category: 'unsupported',
          code: 'offset_face_chamfer_rim_not_carried'
        });
        expect(refusal!.message).toContain(
          "This face's chamfered edge can't move with it here."
        );
      }
    });
  }

  it('counts only the chamfers that built the edited body', () => {
    const f = fixtures.get('sharp')!;
    const other = addPrimitiveFeature(f.document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const otherBody = other.bodyOrder.at(-1)!;
    const later = toFeatureId('feat_later');
    expect(chamferSetbacksBefore(other, later, f.bodyId, {})).toEqual([
      [CHAMFER, CHAMFER]
    ]);
    // A chamfer elsewhere in the document cannot have made a band here.
    expect(chamferSetbacksBefore(other, later, otherBody, {})).toEqual([]);
  });

  describe('a chamfer-shaped band with no history (a STEP import)', () => {
    const imported = new Map<string, Fixture>();
    /** tan 10°: the drafted foot's taper per unit of height. */
    const TAPER = Math.tan((10 * Math.PI) / 180);
    const FOOT = 5;

    function edgesWhere(
      kernel: RemusKernel,
      solid: number,
      keep: (a: number[], b: number[]) => boolean
    ): Uint32Array {
      return Uint32Array.from(
        Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
          const v = kernel.getEdgeVertices(edge);
          return keep([v[0]!, v[1]!, v[2]!], [v[3]!, v[4]!, v[5]!]);
        })
      );
    }
    const bottomRim = (a: number[], b: number[]) =>
      near(a[2]!, 0) && near(b[2]!, 0);
    const placed = (kernel: RemusKernel, solid: number, z: number) =>
      kernel.copyAndTransformSolid(
        solid,
        Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, z, 0, 0, 0, 1)
      );

    async function importedFixture(
      name: string,
      build: (kernel: RemusKernel) => number
    ): Promise<Fixture> {
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      const step = new TextDecoder().decode(
        io.exportStep(kernel.serializeSolids(Uint32Array.of(build(kernel))))
      );
      const result = importStepBody(
        createProjectDocument(name, toUserId('user_chamfer_rim')),
        {
          name: 'Block',
          sourceName: `${name}.step`,
          artifactId: `artifact_${name}`,
          stepText: step
        }
      );
      const derived = await adapter.syncDocument(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      const bottom = body
        .topology!.faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            face.geometry.normal!.z < -0.999
        )
        .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
      return {
        document: result.document,
        bodyId: result.bodyId,
        bottom,
        volume: body.volume,
        section: X * Y
      };
    }

    beforeAll(async () => {
      imported.set(
        'sharp',
        await importedFixture('imported-sharp', (kernel) => {
          const box = kernel.makeBox(X, Y, Z);
          return kernel.chamfer(
            box,
            edgesWhere(kernel, box, bottomRim),
            CHAMFER
          );
        })
      );
      imported.set(
        'one-edge',
        await importedFixture('imported-one-edge', (kernel) => {
          const box = kernel.makeBox(X, Y, Z);
          return kernel.chamfer(
            box,
            edgesWhere(
              kernel,
              box,
              (a, b) => bottomRim(a, b) && near(a[1]!, 0) && near(b[1]!, 0)
            ),
            CHAMFER
          );
        })
      );
      imported.set(
        'rounded',
        await importedFixture('imported-rounded', (kernel) => {
          const box = kernel.makeBox(X, Y, Z);
          const rounded = kernel.filletDetailed(
            box,
            edgesWhere(
              kernel,
              box,
              (a, b) => near(a[0]!, b[0]!) && near(a[1]!, b[1]!)
            ),
            ROUND,
            true
          );
          if (rounded.status !== 'ok') throw new Error('fixture fillet');
          return kernel.chamfer(
            rounded.value,
            edgesWhere(kernel, rounded.value, bottomRim),
            CHAMFER
          );
        })
      );
      // A foot drafted 10° in under straight walls: the shape of a chamfer
      // band, 5 tall, made by a draft.
      imported.set(
        'drafted',
        await importedFixture('imported-drafted', (kernel) => {
          const foot = kernel.makeBox(X, Y, FOOT);
          const sides = Uint32Array.from(
            Array.from(kernel.getSolidFaces(foot)).filter(
              (face) => Math.abs(kernel.getFaceNormal(face)[2]!) < 0.5
            )
          );
          const drafted = kernel.draft(foot, sides, 0, 0, 1, 0, 0, FOOT, 10);
          return kernel.fuse(
            drafted,
            placed(kernel, kernel.makeBox(X, Y, Z - FOOT), FOOT)
          );
        })
      );
      // A Ø10 through hole chamfered with the rim: the kernel's move
      // carries this band, which the guard must accept.
      imported.set(
        'holed',
        await importedFixture('imported-holed', (kernel) => {
          const bore = kernel.copyAndTransformSolid(
            kernel.makeCylinder(5, Z + 10),
            Float64Array.of(1, 0, 0, 20, 0, 1, 0, 20, 0, 0, 1, -5, 0, 0, 0, 1)
          );
          const plate = kernel.cut(kernel.makeBox(X, Y, Z), bore);
          return kernel.chamfer(
            plate,
            edgesWhere(kernel, plate, bottomRim),
            CHAMFER
          );
        })
      );
    });

    it('keeps an imported bottom rim ambiguous after an equal chamfer is added on top', async () => {
      const original = imported.get('sharp')!;
      const edges = (await edgesOf(original.document, original.bodyId)).filter(
        along((_x, _y, z) => near(z, Z))
      );
      expect(edges).toHaveLength(4);
      const added = chamferEdges(original.document, {
        name: 'Top chamfer',
        targetBodyId: original.bodyId,
        edgeHashes: edges.map((e) => e.hash),
        size: CHAMFER
      });
      const baseline = await adapter.syncDocument(added.document);
      expect(baseline.warnings).toEqual([]);
      const body = baseline.bodyRepresentations[added.bodyId]!;
      const bottom = body.topology!.faces.find(
        (f) => f.geometry?.normal?.z === -1
      )!;
      const fixture = { ...original, ...added, bottom, volume: body.volume };
      const top = body.topology!.faces.find(
        (f) => f.geometry?.normal?.z === 1
      )!;
      const authored = await adapter.syncDocument(
        offsetBy({ ...fixture, bottom: top }, 2, 'refuse')
      );
      expect(failures(authored.featureWarnings)).toEqual([]);
      expect(
        authored.bodyRepresentations[added.bodyId]!.volume - body.volume
      ).toBeCloseTo(2 * X * Y, 5);
      const current = await adapter.syncDocument(
        offsetBy(fixture, 2, 'refuse')
      );
      expect(failures(current.featureWarnings)[0]?.kernelRefusal?.code).toBe(
        'ambiguous_rim_chamfer'
      );
      const historical = await adapter.syncDocument(offsetBy(fixture, 2));
      expect(failures(historical.featureWarnings)).toEqual([]);
      expect(
        historical.bodyRepresentations[added.bodyId]!.volume - body.volume
      ).toBeCloseTo(2 * X * Y, 5);
    });

    it.each([
      ['bevel', 52265.05383333333],
      ['opposite', 52787.80716666669],
      ['symmetric', 52621.030500000015]
    ] as const)(
      'replays Face Distance on an imported bevel (%s)',
      async (side, historicalVolume) => {
        const fixture = imported.get('sharp')!;
        const source = await adapter.syncDocument(fixture.document);
        const topology = source.bodyRepresentations[fixture.bodyId]!.topology!;
        const pair = topology.opposingPlanarFacePairs!.find(
          (p) =>
            p.faceAHash === fixture.bottom.hash ||
            p.faceBHash === fixture.bottom.hash
        )!;
        const moveFirst =
          (pair.faceAHash === fixture.bottom.hash) === (side === 'bevel');
        const manager = new CommandManager(fixture.document);
        manager.execute(
          commandFactories.directEditBody({
            name: 'Face Distance',
            targetBodyId: fixture.bodyId,
            operation: {
              kind: 'set-face-distance',
              faceHash: pair.faceAHash,
              oppositeFaceHash: pair.faceBHash,
              faceReference: pair.faceAReference,
              oppositeFaceReference: pair.faceBReference,
              moveMode:
                side === 'symmetric'
                  ? 'symmetric'
                  : moveFirst
                    ? 'one-sided-first'
                    : 'one-sided-second',
              sourceDistance: pair.distance,
              distance: pair.distance + 2
            }
          })
        );
        manager.undo();
        expect(
          (await adapter.syncDocument(manager.document)).bodyRepresentations[
            fixture.bodyId
          ]!.volume
        ).toBeCloseTo(fixture.volume, 6);
        manager.redo();
        const saved = normalizeDocument(
          JSON.parse(JSON.stringify(manager.document))
        );
        const cold = new RemusKernelAdapter();
        try {
          const rebuilt = await cold.syncDocument(saved);
          expect(rebuilt.warnings).toEqual([]);
          // Frozen v2026.1.163 result for the 60 × 40 × 20 block with a 0.35 mm bevel.
          expect(
            rebuilt.bodyRepresentations[fixture.bodyId]!.volume
          ).toBeCloseTo(historicalVolume, 6);
        } finally {
          cold.dispose();
        }
      }
    );

    it('requires a choice for a new Offset Face on an imported band', async () => {
      const candidate = offsetBy(imported.get('sharp')!, 2, 'refuse');
      for (const state of [
        await adapter.previewGeometry(candidate, { deferTopology: true }),
        await adapter.syncDocument(candidate)
      ]) {
        const refused = failures(state.featureWarnings);
        expect(refused).toHaveLength(1);
        expect(refused[0]?.kernelRefusal?.code).toBe('ambiguous_rim_chamfer');
      }
    });

    it('carries a chosen chamfer and re-limits a chosen draft on the same imported band', async () => {
      const f = imported.get('sharp')!;
      const carry = await adapter.syncDocument(offsetBy(f, 2, 'chamfer'));
      const draft = await adapter.syncDocument(offsetBy(f, 2, 'draft'));
      expect(failures(carry.featureWarnings)).toEqual([]);
      expect(failures(draft.featureWarnings)).toEqual([]);
      const volume = (state: typeof carry) =>
        Object.values(state.bodyRepresentations).at(-1)!.volume;
      expect(volume(carry) - f.volume).toBeCloseTo(2 * f.section, 6);
      expect(volume(draft) - f.volume).toBeCloseTo(swept(relimit.sharp, 2), 6);
    });

    async function offsetImported(shape: string, offset: number) {
      const f = imported.get(shape)!;
      const candidate = offsetBy(f, offset);
      const preview = await adapter.previewGeometry(candidate, {
        deferTopology: true
      });
      const committed = await adapter.syncDocument(candidate);
      return { f, preview, committed };
    }

    /**
     * The base's sides as a function of how far it has moved out (`t`): the
     * tilted faces stay where they are and the base re-limits along them.
     * Its area, and the volume it sweeps, integrated exactly.
     */
    const relimit = {
      sharp: (t: number) => [X - 2 * (CHAMFER + t), Y - 2 * (CHAMFER + t)],
      'one-edge': (t: number) => [X, Y - (CHAMFER + t)],
      drafted: (t: number) => [
        X - 2 * TAPER * (FOOT + t),
        Y - 2 * TAPER * (FOOT + t)
      ]
    } as const;
    const swept = (sides: (t: number) => number[], t: number) => {
      // Each side is linear in t, so the area is quadratic: Simpson's rule
      // is exact for it.
      const area = (s: number) => sides(s)[0]! * sides(s)[1]!;
      return (t / 6) * (area(0) + 4 * area(t / 2) + area(t));
    };

    for (const [shape, offsets] of [
      ['sharp', [2, 0.1, -0.1, -0.3]],
      ['one-edge', [20, 2, -0.1, -0.3]],
      ['drafted', [20, 2, 0.1, -0.1, -2]]
    ] as const) {
      for (const offset of offsets) {
        it(`${shape}: keeps the kernel's re-limit at ${offset}`, async () => {
          const { f, preview, committed } = await offsetImported(shape, offset);
          expect(failures(preview.featureWarnings)).toEqual([]);
          expect(failures(committed.featureWarnings)).toEqual([]);
          const body = Object.values(committed.bodyRepresentations).at(-1)!;
          expect(body.bbox.min.x).toBeCloseTo(0, 6);
          expect(body.bbox.max.x).toBeCloseTo(X, 6);
          expect(body.bbox.min.y).toBeCloseTo(0, 6);
          expect(body.bbox.max.y).toBeCloseTo(Y, 6);
          expect(body.bbox.min.z).toBeCloseTo(-offset, 6);
          const sides = relimit[shape];
          const moved = body.topology!.faces.filter(
            (face) =>
              face.geometry?.surfaceType === 'plane' &&
              face.geometry.normal!.z < -0.999
          );
          expect(moved).toHaveLength(1);
          expect(moved[0]!.geometry!.area).toBeCloseTo(
            sides(offset)[0]! * sides(offset)[1]!,
            6
          );
          expect(body.volume).toBeCloseTo(f.volume + swept(sides, offset), 2);
        });
      }
    }

    for (const [shape, offset, limit] of [
      // Past the band's top: the kernel's move built a body wider than its
      // walls (the one-edge body ~34 000 mm³ short at -2).
      ['sharp', -2, -CHAMFER],
      ['sharp', -12, -CHAMFER],
      ['one-edge', -2, -CHAMFER],
      ['drafted', -12, -FOOT],
      // Pulled until the tilted faces cross: the base turned inside out, or
      // (both pairs crossed, at 120) kept its winding over a wider body.
      ['sharp', 20, undefined],
      ['sharp', 120, undefined],
      ['one-edge', 120, undefined],
      ['drafted', 120, undefined]
    ] as const) {
      it(`${shape}: refuses ${offset}, where no reading of the band holds`, async () => {
        const { f, preview, committed } = await offsetImported(shape, offset);
        for (const derived of [preview, committed]) {
          const [refusal] = failures(derived.featureWarnings);
          expect(refusal, 'the offset is refused').toBeDefined();
          expect(refusal!.kernelRefusal).toMatchObject({
            family: 'direct-edit',
            category: 'unsupported',
            code: 'offset_face_chamfer_rim_not_carried'
          });
          expect(refusal!.kernelRefusal!.limit).toBe(limit);
          expect(refusal!.message).toContain(
            "This face's chamfered or drafted edge can't move with it"
          );
        }
        // Nothing was committed: the body is the import, unchanged.
        const body = committed.bodyRepresentations[f.bodyId]!;
        expect(body.volume).toBeCloseTo(f.volume, 6);
      });
    }

    // Review regressions: a nearly flat bevel the guard must still see, a
    // small loop far from the origin whose winding must survive, and an
    // offset just inside the band's top that must stay the kernel's.
    it('flatter bevel: refuses the spread without reading the band', async () => {
      // 10 across, 0.00001 up: tilted within 5e-13 of parallel.
      const f = await importedFixture('imported-flatter-bevel', (kernel) => {
        const box = kernel.makeBox(X, Y, Z);
        return kernel.chamferV2(
          box,
          edgesWhere(kernel, box, bottomRim),
          10,
          0.00001
        );
      });
      const candidate = offsetBy(f, -2);
      for (const derived of [
        await adapter.previewGeometry(candidate, { deferTopology: true }),
        await adapter.syncDocument(candidate)
      ]) {
        const [refusal] = failures(derived.featureWarnings);
        expect(refusal, 'the offset is refused').toBeDefined();
        expect(refusal!.kernelRefusal?.code).toBe(
          'offset_face_chamfer_rim_not_carried'
        );
      }
      const body = (await adapter.syncDocument(candidate)).bodyRepresentations[
        f.bodyId
      ]!;
      expect(body.bbox.min.x).toBeCloseTo(0, 6);
      expect(body.bbox.max.x).toBeCloseTo(X, 6);
    });

    it("opposite rim: another edge's chamfer does not carry an imported band", async () => {
      // An imported 10 × 0.01 base bevel, and a same-sized chamfer the user
      // adds to the top rim. The base is still a band with no chamfer of
      // its own in the history: it keeps the kernel's re-limit.
      const f = await importedFixture('imported-opposite-rim', (kernel) => {
        const box = kernel.makeBox(X, Y, Z);
        return kernel.chamferV2(
          box,
          edgesWhere(kernel, box, bottomRim),
          10,
          0.01
        );
      });
      const top = (await adapter.syncDocument(f.document)).bodyRepresentations[
        f.bodyId
      ]!.topology!.edges.filter(along((_x, _y, z) => near(z, Z)));
      expect(top).toHaveLength(4);
      const chamfered = chamferEdges(f.document, {
        name: 'Top chamfer',
        targetBodyId: f.bodyId,
        edgeHashes: top.map((edge) => edge.hash),
        edgeReferences: top.map((edge) => edge.reference!),
        size: 10,
        distance2: 0.01
      });
      const before = await adapter.syncDocument(chamfered.document);
      expect(before.warnings).toEqual([]);
      const bottom = before.bodyRepresentations[
        chamfered.bodyId
      ]!.topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z < -0.999
      ).sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
      expect(bottom.geometry!.area).toBeCloseTo(800, 6);
      const committed = await adapter.syncDocument(
        offsetBy(
          {
            document: chamfered.document,
            bodyId: chamfered.bodyId,
            bottom,
            volume: 0,
            section: 0
          },
          -0.005
        )
      );
      expect(failures(committed.featureWarnings)).toEqual([]);
      const moved = Object.values(committed.bodyRepresentations)
        .at(-1)!
        .topology!.faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            face.geometry.normal!.z < -1 + 1e-12 &&
            near(face.geometry.center.z, 0.005)
        );
      expect(moved).toHaveLength(1);
      // Re-limited halfway up the 0.01 bevel: 50 × 30, not carried at 800.
      expect(moved[0]!.geometry!.area).toBeCloseTo(1500, 4);
    });

    it('flat bevel: refuses the move that spread the body 2000 wide', async () => {
      const f = await importedFixture('imported-flat-bevel', (kernel) => {
        const box = kernel.makeBox(X, Y, Z);
        // 10 across the base, 0.01 up the walls.
        return kernel.chamferV2(
          box,
          edgesWhere(kernel, box, bottomRim),
          10,
          0.01
        );
      });
      const candidate = offsetBy(f, -2);
      for (const derived of [
        await adapter.previewGeometry(candidate, { deferTopology: true }),
        await adapter.syncDocument(candidate)
      ]) {
        const [refusal] = failures(derived.featureWarnings);
        expect(refusal, 'the offset is refused').toBeDefined();
        expect(refusal!.kernelRefusal?.code).toBe(
          'offset_face_chamfer_rim_not_carried'
        );
      }
    });

    it("far from the origin: keeps a small band's winding", async () => {
      const f = await importedFixture('imported-far', (kernel) => {
        const box = kernel.copyAndTransformSolid(
          kernel.makeBox(0.1, 0.1, Z),
          Float64Array.of(1, 0, 0, 1e7, 0, 1, 0, 1e7, 0, 0, 1, 0, 0, 0, 0, 1)
        );
        return kernel.chamfer(box, edgesWhere(kernel, box, bottomRim), 0.005);
      });
      const candidate = offsetBy(f, 0.005);
      const preview = await adapter.previewGeometry(candidate, {
        deferTopology: true
      });
      expect(failures(preview.featureWarnings)).toEqual([]);
      const committed = await adapter.syncDocument(candidate);
      expect(failures(committed.featureWarnings)).toEqual([]);
      const body = Object.values(committed.bodyRepresentations).at(-1)!;
      expect(body.bbox.min.z).toBeCloseTo(-0.005, 6);
    });

    it('just inside the band top: keeps the kernel re-limit', async () => {
      const f = await importedFixture('imported-tall', (kernel) => {
        const box = kernel.makeBox(X, Y, 40);
        return kernel.chamfer(box, edgesWhere(kernel, box, bottomRim), 5);
      });
      const candidate = offsetBy(f, -4.9999996);
      const preview = await adapter.previewGeometry(candidate, {
        deferTopology: true
      });
      expect(failures(preview.featureWarnings)).toEqual([]);
      const committed = await adapter.syncDocument(candidate);
      expect(failures(committed.featureWarnings)).toEqual([]);
    });

    it('rounded: leaves the kernel refusal over rounded corners alone', async () => {
      // The kernel refuses this band's move at any distance; refusing is
      // right for a draft, and nothing here can tell it from a chamfer.
      for (const offset of [2, -0.1, -2]) {
        const { committed } = await offsetImported('rounded', offset);
        const [refusal] = failures(committed.featureWarnings);
        expect(refusal, `${offset} is refused`).toBeDefined();
        expect(refusal!.kernelRefusal?.code).toBe('offset_face_refused');
      }
    });

    for (const offset of [20, 2, -2, -12]) {
      it(`holed: accepts the kernel carrying the band at ${offset}`, async () => {
        const { f, committed } = await offsetImported('holed', offset);
        expect(failures(committed.featureWarnings)).toEqual([]);
        const body = Object.values(committed.bodyRepresentations).at(-1)!;
        expect(body.bbox.min.z).toBeCloseTo(-offset, 6);
        expect(body.volume).toBeCloseTo(
          f.volume + offset * (X * Y - Math.PI * 25),
          2
        );
      });
    }
  });

  describe('the carry on bare kernel bodies', () => {
    const bottomOf = (kernel: RemusKernel, solid: number) =>
      Array.from(kernel.getSolidFaces(solid)).find(
        (face) =>
          kernel.getSurfaceType(face) === 'plane' &&
          kernel.getFaceNormal(face)[2]! < -0.999
      )!;
    const bottomEdges = (kernel: RemusKernel, solid: number) =>
      Uint32Array.from(
        Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
          const v = kernel.getEdgeVertices(edge);
          return near(v[2]!, 0) && near(v[5]!, 0);
        })
      );

    it('carries a chamfered hole mouth with the outer rim', () => {
      const kernel = new RemusKernel();
      // A Ø10 through hole whose bottom mouth is chamfered with the rim, so
      // the band includes a full cone and its seam.
      const bore = kernel.copyAndTransformSolid(
        kernel.makeCylinder(5, Z + 10),
        Float64Array.of(1, 0, 0, 20, 0, 1, 0, 20, 0, 0, 1, -5, 0, 0, 0, 1)
      );
      const plate = kernel.cut(kernel.makeBox(X, Y, Z), bore);
      const solid = kernel.chamfer(plate, bottomEdges(kernel, plate), CHAMFER);
      const volume = kernel.volume(solid, 1e-3);
      const section = X * Y - Math.PI * 25;
      for (const offset of [20, 2, -2, -12]) {
        const carried = tryCarryChamferRim(
          kernel,
          solid,
          bottomOf(kernel, solid),
          offset,
          [[CHAMFER, CHAMFER]]
        );
        expect(carried).not.toBeNull();
        expect(kernel.validateSolid(carried!.solid)).toBe(0);
        expect(kernel.volume(carried!.solid, 1e-3)).toBeCloseTo(
          volume + offset * section,
          2
        );
      }
    });

    it('refuses a wall that leans enough to leave the rim off it', () => {
      // Walls 8e-8 rad off vertical pass the analytic match, but sliding the
      // rim 1000 along them would leave it 8e-5 off its wall planes.
      const kernel = new RemusKernel();
      const box = kernel.makeBox(30, 30, 0.5);
      const leaning = kernel.copyAndTransformSolid(
        box,
        Float64Array.of(1, 0, 8e-8, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
      );
      const solid = kernel.chamfer(leaning, bottomEdges(kernel, leaning), 0.1);
      const bottom = bottomOf(kernel, solid);
      expect(() =>
        tryCarryChamferRim(kernel, solid, bottom, 1000, [[0.1, 0.1]])
      ).toThrow(/chamfered edge can't move with it/);
    });

    it("accepts the kernel's move of round bands and loops, and reads its faults", () => {
      const kernel = new RemusKernel();
      const bore = (x: number) =>
        kernel.copyAndTransformSolid(
          kernel.makeCylinder(4, Z + 10),
          Float64Array.of(1, 0, 0, x, 0, 1, 0, 20, 0, 0, 1, -5, 0, 0, 0, 1)
        );
      // Two chamfered hole mouths beside each other in a chamfered base:
      // the base's loops hold two circles as well as its lines.
      const plate = kernel.cut(
        kernel.cut(kernel.makeBox(X, Y, Z), bore(20)),
        bore(30)
      );
      const twoHoles = kernel.chamfer(
        plate,
        bottomEdges(kernel, plate),
        CHAMFER
      );
      // A drafted cone foot under a column: one circle.
      const coneFoot = kernel.fuse(
        kernel.makeCone(10, 15, 10),
        kernel.copyAndTransformSolid(
          kernel.makeCylinder(15, 30),
          Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 10, 0, 0, 0, 1)
        )
      );
      for (const solid of [twoHoles, coneFoot]) {
        const bottom = bottomOf(kernel, solid);
        for (const offset of [2, -0.1]) {
          const guard = guardUncarriedChamferBand(
            kernel,
            solid,
            bottom,
            offset
          );
          expect(guard).not.toBeNull();
          const handle = kernel.prepareMoveFacesWithOptions(
            solid,
            Uint32Array.of(bottom),
            JSON.stringify({ ambiguousRim: 'legacyReplay' })
          );
          const moved = kernel.moveFacesPrepared(handle, offset);
          kernel.releasePreparedMove(handle);
          expect(() => guard!.validate(moved)).not.toThrow();
          // The unmoved body leaves the face short of where it was sent.
          expect(() => guard!.validate(solid)).toThrow(
            /chamfered or drafted edge can't move with it/
          );
        }
      }
      // A plain box has no band to guard.
      const box = kernel.makeBox(X, Y, Z);
      expect(
        guardUncarriedChamferBand(kernel, box, bottomOf(kernel, box), 2)
      ).toBeNull();
    });

    it('leaves a drafted section on straight walls to the kernel move', () => {
      // A frustum foot under a straight cylinder: its side is a cone about
      // the bottom's normal standing on a wall, the shape of a chamfer band,
      // but no chamfer in the history made it. Re-limiting it is the right
      // move, and stays the kernel's.
      const kernel = new RemusKernel();
      const foot = kernel.makeCone(10, 15, 10);
      const column = kernel.copyAndTransformSolid(
        kernel.makeCylinder(15, 30),
        Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 10, 0, 0, 0, 1)
      );
      const solid = kernel.fuse(foot, column);
      const bottom = bottomOf(kernel, solid);
      for (const setbacks of [[], [[CHAMFER, CHAMFER]]] as const) {
        expect(
          tryCarryChamferRim(kernel, solid, bottom, -2, setbacks)
        ).toBeNull();
        expect(
          tryCarryChamferRim(kernel, solid, bottom, 2, setbacks)
        ).toBeNull();
      }
    });
  });
});
