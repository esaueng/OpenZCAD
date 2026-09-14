import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { drillHole } from './exact-cylinder-ops';
import { collectRecognizedImportedFeatures } from './imported-feature-query';
import {
  crossCheckHoleClaims,
  parseKernelFeatureClaims,
  type KernelFeatureClaim
} from './remus-feature-recognition';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from './remus-runtime';
import type { ImportedFeatureProof } from './imported-feature-recognition';

/**
 * The kernel's recognizer publishes the two families the exact recognizer does
 * not — rectangular pockets and fillet bands — and cross-checks the ones it
 * does. These tests pin all three halves of that contract: what the kernel's
 * claims now add, that they add nothing to an exact hole proof, and that a
 * disagreement costs both answers rather than picking one.
 */
describe('kernel feature recognition', () => {
  let kernel: RemusKernel;

  beforeAll(async () => {
    await loadRemusTranslators();
  });

  beforeEach(() => {
    kernel = new RemusKernel();
  });

  afterEach(() => {
    kernel.free();
  });

  function identities(solid: number) {
    return new Map(
      Array.from(kernel.getSolidFaces(solid)).map((face, index) => [
        face,
        { hash: index + 1 }
      ])
    );
  }

  function recognize(solid: number, onKernel = kernel) {
    return collectRecognizedImportedFeatures(
      onKernel,
      solid,
      identities(solid)
    );
  }

  /**
   * The same kernel with its feature recognizer answering `payload`, or
   * refusing when `payload` is undefined. Everything else is the live kernel,
   * so a test drives exactly one recognizer off its real answer.
   */
  function withKernelClaims(payload?: string): RemusKernel {
    const recognizeFeatures = (): string => {
      if (payload === undefined) {
        throw new Error('feature recognition unavailable');
      }
      return payload;
    };
    return new Proxy(kernel, {
      get(target, property, receiver): unknown {
        if (property === 'recognizeFeatures') {
          return recognizeFeatures;
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      }
    });
  }

  function translated(solid: number, x: number, y: number, z: number): number {
    kernel.transformSolid(
      solid,
      new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1])
    );
    return solid;
  }

  function cut(target: number, tool: number): number {
    const result = kernel.cutDetailed(target, tool);
    expect(result.status).toBe('ok');
    return result.value!;
  }

  /** A 10 × 6 × 3 pocket milled into the top of a 30 × 20 × 8 plate. */
  function pocketedPlate(): number {
    return cut(
      kernel.makeBox(30, 20, 8),
      translated(kernel.makeBox(10, 6, 3), 5, 5, 5)
    );
  }

  /** The same body after a STEP round trip, which is how bodies arrive. */
  function imported(solid: number): number {
    const step = remusTranslators().exportStep(
      kernel.serializeSolids(new Uint32Array([solid]))
    );
    const solids = Array.from(
      kernel.deserializeSolids(
        remusTranslators().importStep(step, step.byteLength, 2_000_000)
      )
    );
    expect(solids).toHaveLength(1);
    return solids[0]!;
  }

  function plateWithHole(style: 'simple' | 'counterbore' | 'countersink') {
    return drillHole(kernel, kernel.makeBox(30, 20, 8), {
      surfacePoint: { x: 10, y: 10, z: 8 },
      axis: { x: 0, y: 0, z: -1 },
      radius: 2.5,
      depth: 6,
      style,
      ...(style === 'counterbore'
        ? { counterboreRadius: 5, counterboreDepth: 2 }
        : {}),
      ...(style === 'countersink'
        ? { countersinkRadius: 5, countersinkAngle: Math.PI / 2 }
        : {}),
      entryExtension: 0.2,
      exitExtension: 0
    });
  }

  /** Two identical blind holes, 14 mm apart in the same plate face. */
  function plateWithTwoHoles(): number {
    const bore = (solid: number, x: number) =>
      drillHole(kernel, solid, {
        surfacePoint: { x, y: 10, z: 8 },
        axis: { x: 0, y: 0, z: -1 },
        radius: 2.5,
        depth: 6,
        style: 'simple',
        entryExtension: 0.2,
        exitExtension: 0
      });
    return bore(bore(kernel.makeBox(30, 20, 8), 8), 22);
  }

  it('publishes a verified rectangular pocket as a read-only feature', () => {
    const solid = imported(pocketedPlate());
    const claimed = parseKernelFeatureClaims(
      kernel.recognizeFeatures(solid, 0.08)
    );
    expect(claimed?.filter((claim) => claim.kind === 'pocket')).toHaveLength(1);

    const recognized = recognize(solid);
    expect(recognized).toHaveLength(1);
    expect(recognized[0]).toMatchObject({
      kind: 'prismatic-pocket',
      depth: 3,
      provenance: 'kernel-recognized'
    });
    // Floor, four walls and the opening plane the walls end on.
    expect(recognized[0]?.participatingFaceHashes).toHaveLength(6);
    // Nothing is published without the kernel's claim: this family is the
    // kernel recognizer's, and the exact one still proves nothing here.
    expect(recognize(solid, withKernelClaims())).toEqual([]);
  });

  it('measures a fillet band exactly rather than trusting the claim', () => {
    const box = kernel.makeBox(30, 20, 8);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;
    const solid = imported(kernel.fillet(box, new Uint32Array([edge]), 0.5));

    const recognized = recognize(solid);
    expect(recognized).toHaveLength(1);
    expect(recognized[0]).toMatchObject({
      kind: 'fillet-band',
      radius: 0.5,
      length: 30,
      sense: 'convex',
      provenance: 'kernel-recognized'
    });
  });

  it('refuses a kernel pocket claim whose material side is a raised pad', () => {
    const fused = kernel.fuseDetailed(
      kernel.makeBox(30, 20, 8),
      translated(kernel.makeBox(10, 6, 3), 5, 5, 8)
    );
    expect(fused.status).toBe('ok');
    const solid = fused.value!;
    expect(
      parseKernelFeatureClaims(kernel.recognizeFeatures(solid, 0.08))?.filter(
        (claim) => claim.kind === 'pocket'
      )
    ).toHaveLength(1);
    expect(recognize(solid)).toEqual([]);
  });

  it('refuses a kernel pocket claim on a slot that runs through the plate', () => {
    const solid = cut(
      kernel.makeBox(30, 20, 8),
      translated(kernel.makeBox(10, 6, 20), 5, 5, -5)
    );
    expect(
      parseKernelFeatureClaims(kernel.recognizeFeatures(solid, 0.08))?.filter(
        (claim) => claim.kind === 'pocket'
      )
    ).toHaveLength(1);
    expect(recognize(solid)).toEqual([]);
  });

  it.each(['simple', 'counterbore', 'countersink'] as const)(
    'leaves the exact %s proof untouched by kernel recognition',
    (style) => {
      const solid = plateWithHole(style);
      const withRecognizer = recognize(solid);
      const withoutRecognizer = recognize(solid, withKernelClaims());

      expect(withRecognizer).toEqual(withoutRecognizer);
      expect(withRecognizer).toHaveLength(1);
      expect(withRecognizer[0]?.provenance).toBeUndefined();
      expect(withRecognizer[0]?.kind).toBe(
        style === 'simple' ? 'blind-cylindrical-hole' : style
      );
    }
  );

  it('withdraws both answers when the recognizers disagree about a hole', () => {
    const solid = plateWithHole('simple');
    const agreed = recognize(solid);
    expect(agreed).toHaveLength(1);
    expect(agreed[0]?.kind).toBe('blind-cylindrical-hole');

    const wall = Array.from(kernel.getSolidFaces(solid)).find(
      (face) => kernel.getSurfaceType(face) === 'cylinder'
    );
    expect(wall).toBeDefined();
    const disagreeing = recognize(
      solid,
      withKernelClaims(
        JSON.stringify([
          { type: 'hole', faces: [wall], diameter: 9, through: false }
        ])
      )
    );

    // Neither the exact 5 mm proof nor the kernel's 9 mm claim survives.
    expect(disagreeing).toEqual([]);
  });

  it('keeps the kernel out of the family it does not own', () => {
    const solid = plateWithHole('simple');
    const wall = Array.from(kernel.getSolidFaces(solid)).find(
      (face) => kernel.getSurfaceType(face) === 'cylinder'
    );
    // An agreeing claim publishes no second answer for the same bore, and a
    // hole the exact recognizer never proved is never published either.
    expect(
      recognize(
        solid,
        withKernelClaims(
          JSON.stringify([
            { type: 'hole', faces: [wall], diameter: 5, through: false },
            { type: 'hole', faces: [9999], diameter: 3, through: true }
          ])
        )
      )
    ).toEqual(recognize(solid, withKernelClaims('[]')));
  });

  it('drops a seed-hash collision whether or not the kernel claims anything', () => {
    const solid = plateWithTwoHoles();
    // Distinct identities publish both bores; this is the control.
    expect(recognize(solid)).toHaveLength(2);

    // The ADR-011 fingerprint is 32-bit, so two same-kind proofs on one body
    // can in principle land on one hash. A proposal binds by (kind, seed
    // hash), so such a pair must be dropped — on BOTH paths, including the
    // one taken when the kernel's payload cannot be read.
    const collided = new Map(
      Array.from(kernel.getSolidFaces(solid)).map((face, index) => [
        face,
        { hash: kernel.getSurfaceType(face) === 'cylinder' ? 777 : index + 1 }
      ])
    );
    const withRecognizer = collectRecognizedImportedFeatures(
      kernel,
      solid,
      collided
    );
    const withoutRecognizer = collectRecognizedImportedFeatures(
      withKernelClaims(),
      solid,
      collided
    );
    expect(withRecognizer).toEqual([]);
    expect(withoutRecognizer).toEqual(withRecognizer);
  });

  it.each([
    'samples/parametric-bracket.step',
    'test/fixtures/hammer-holder/synthetic-holder.step',
    'test/fixtures/hammer-holder/synthetic-holder-open.step'
  ])('publishes nothing new for %s', (file) => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../${file}`, import.meta.url))
    );
    const solids = Array.from(
      kernel.deserializeSolids(
        remusTranslators().importStep(bytes, bytes.byteLength, 2_000_000)
      )
    );
    expect(solids.length).toBeGreaterThan(0);
    for (const solid of solids) {
      // Each of these fixtures carries kernel claims — open slots, a raised
      // pad, conical seats read as bands — and not one of them survives its
      // witness, so the published features are exactly what they were.
      expect(
        parseKernelFeatureClaims(kernel.recognizeFeatures(solid, 0.08))?.length
      ).toBeGreaterThan(0);
      expect(recognize(solid)).toEqual(recognize(solid, withKernelClaims()));
    }
  });

  describe('claim decoding', () => {
    it('decodes the payload the pinned kernel publishes', () => {
      expect(
        parseKernelFeatureClaims(
          JSON.stringify([
            { diameter: 5, faces: [21], through: false, type: 'hole' },
            { floor: 45, type: 'pocket', walls: [41, 42, 43, 44] },
            { area: 23.56, face: 6, type: 'filletLike' },
            { adjacent: [90, 91], angle: 0.785, face: 94, type: 'chamfer' }
          ])
        )
      ).toEqual([
        { kind: 'hole', faceIds: [21], diameter: 5, through: false },
        { kind: 'pocket', floorFaceId: 45, wallFaceIds: [41, 42, 43, 44] },
        { kind: 'fillet-band', faceId: 6 }
      ]);
    });

    it.each([
      'not json',
      '{"type":"pocket"}',
      JSON.stringify([{ type: 'hole', faces: [1], through: false }]),
      JSON.stringify([{ type: 'hole', faces: [], diameter: 5, through: true }]),
      JSON.stringify([{ type: 'pocket', floor: 1.5, walls: [2, 3, 4] }]),
      JSON.stringify([{ type: 'pocket', floor: 1, walls: [2, 2, 3] }]),
      JSON.stringify([{ type: 'filletLike', area: 1 }])
    ])('refuses the whole payload for %s', (payload) => {
      expect(parseKernelFeatureClaims(payload)).toBeNull();
    });
  });

  describe('hole cross-check', () => {
    const proof = {
      kind: 'counterbore',
      participatingFaceIds: ['4', '5', '6', '7'],
      innerDiameter: 5,
      outerDiameter: 10
    } as unknown as ImportedFeatureProof;
    const holeClaim = (
      faceIds: number[],
      diameter: number
    ): KernelFeatureClaim => ({
      kind: 'hole',
      faceIds,
      diameter,
      through: false
    });

    it('accepts the bore diameter the kernel reports for a counterbore', () => {
      expect(crossCheckHoleClaims(proof, [holeClaim([4, 6], 5)])).toBe(
        'agrees'
      );
      expect(crossCheckHoleClaims(proof, [holeClaim([4, 6], 10)])).toBe(
        'agrees'
      );
    });

    it('reads silence as agreement-free, not as disagreement', () => {
      expect(crossCheckHoleClaims(proof, [])).toBe('unclaimed');
      expect(crossCheckHoleClaims(proof, [holeClaim([99], 5)])).toBe(
        'unclaimed'
      );
    });

    it('contradicts on a wrong diameter or a split bore', () => {
      expect(crossCheckHoleClaims(proof, [holeClaim([4], 6)])).toBe(
        'contradicted'
      );
      expect(
        crossCheckHoleClaims(proof, [holeClaim([4], 5), holeClaim([6], 10)])
      ).toBe('contradicted');
    });

    it('contradicts a bore claim laid over a family the kernel cannot read', () => {
      const boss = {
        kind: 'cylindrical-boss',
        participatingFaceIds: ['4', '5'],
        diameter: 6
      } as unknown as ImportedFeatureProof;
      expect(crossCheckHoleClaims(boss, [holeClaim([4], 6)])).toBe(
        'contradicted'
      );
    });
  });
});
