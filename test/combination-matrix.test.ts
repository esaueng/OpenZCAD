import { describe, expect, it } from 'vitest';
import {
  allCells,
  campaignCells,
  smokeCells
} from './support/combination-matrix';
import {
  chamferSection,
  closedFormVolume,
  cornerVolumeChange,
  filletSection,
  overlapWithError,
  place,
  vec
} from './support/combination-oracle';
import { defineLedgerSuite } from './support/combination-matrix-suite';
import {
  convexCircleChange,
  expectedVolume,
  importedTwinCells,
  initialModel,
  runTwinCell,
  TWIN_VARIANTS,
  twinCampaignCells,
  twinReproduction,
  twinSmokeCells
} from './support/imported-twin';

/**
 * K10 CI slice: the sphere × cylinder first slice plus one representative
 * per family, boolean, modifier and follow-up, against
 * `combination-matrix.ledger.json`. The rest of the campaign runs in
 * `combination-matrix.full.test.ts` (full suite only). See
 * docs/plans/kernel-robustness-plan-2026-11-05.md (WS1).
 */
describe('K10 oracles agree with closed forms', () => {
  it('integrates the sphere/boss overlap against the separately derived protrusion', () => {
    // The upright boss of test/sphere-cylinder-union.test.ts.
    const sphere = place({ family: 'sphere', radius: 73.5 }, [
      { translation: vec(25.5, -1.5, 0) }
    ]);
    const boss = place(
      { family: 'cylinder', radius: 6, height: 64.10000000000001 },
      [{ translation: vec(0, 0, 58) }]
    );
    const overlap = overlapWithError(boss, sphere);
    const protrusion = closedFormVolume(boss.solid) - overlap.value;
    expect(Math.abs(protrusion - 6030.504746075203)).toBeLessThan(0.05);
  });

  it('integrates the Steinmetz bicylinder, a spherical cap and a half torus', () => {
    const r = 10;
    const bar = place({ family: 'cylinder', radius: r, height: 60 }, [
      { translation: vec(-30, 0, 0), rotationDeg: vec(0, 90, 0) }
    ]);
    const drill = place({ family: 'cylinder', radius: r, height: 60 }, [
      { translation: vec(0, 0, -30) }
    ]);
    const steinmetz = overlapWithError(drill, bar);
    expect(Math.abs(steinmetz.value - (16 * r ** 3) / 3)).toBeLessThan(
      Math.max(4 * steinmetz.error, 1e-3)
    );

    const box = place({ family: 'box', width: 60, height: 60, depth: 20 }, []);
    const ball = place({ family: 'sphere', radius: 10 }, [
      { translation: vec(30, 30, 20) }
    ]);
    const within = (got: { value: number; error: number }, exact: number) =>
      expect(Math.abs(got.value - exact)).toBeLessThan(
        Math.max(4 * got.error, 1e-7 * exact)
      );
    within(overlapWithError(ball, box), (2 / 3) * Math.PI * 1000);
    const ring = place({ family: 'torus', majorRadius: 15, minorRadius: 4 }, [
      { translation: vec(30, 30, 20) }
    ]);
    within(overlapWithError(ring, box), Math.PI ** 2 * 15 * 16);

    const cone = place(
      { family: 'cone', bottomRadius: 10, topRadius: 4, height: 30 },
      [{ translation: vec(30, 30, 32), rotationDeg: vec(180, 0, 0) }]
    );
    // The frustum below z = 20: radius 4 at z = 2 widening to 7.6 at z = 20.
    const inside = (Math.PI * 18 * (16 + 4 * 7.6 + 7.6 ** 2)) / 3;
    within(overlapWithError(cone, box), inside);
  });

  it('sections fillets and chamfers at any corner angle', () => {
    const right = filletSection([1, 0], [0, 1], 2);
    expect(right.area).toBeCloseTo(4 * (1 - Math.PI / 4), 12);
    expect(chamferSection([1, 0], [0, 1], 2).area).toBeCloseTo(2, 12);
    // A 60° corner against a brute-force grid of the region outside the arc.
    const angle = Math.PI / 3;
    const d2 = [Math.cos(angle), Math.sin(angle)] as const;
    const section = filletSection([1, 0], d2, 1);
    const centreDistance = 1 / Math.sin(angle / 2);
    const o = [
      Math.cos(angle / 2) * centreDistance,
      Math.sin(angle / 2) * centreDistance
    ];
    const n = 1500;
    const extent = 2;
    let area = 0;
    let mx = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const x = (extent * (i + 0.5)) / n;
        const y = (extent * (j + 0.5)) / n;
        const inWedge = y >= 0 && Math.atan2(y, x) <= angle;
        const t = 1 / Math.tan(angle / 2);
        const nearCorner = x * 1 + y * 0 <= t && x * d2[0] + y * d2[1] <= t;
        const outsideArc = Math.hypot(x - o[0]!, y - o[1]!) > 1;
        if (inWedge && nearCorner && outsideArc) {
          area += (extent / n) ** 2;
          mx += x * (extent / n) ** 2;
        }
      }
    }
    expect(section.area).toBeCloseTo(area, 3);
    expect(section.centroid[0]).toBeCloseTo(mx / area, 2);
    // Pappus on a boss seam: a concave r 2 fillet round an r 6 boss adds
    // (1 − π/4)·4 · 2π · (6 + x̄).
    const added = cornerVolumeChange(
      {
        kind: 'circle',
        center: vec(0, 0, 0),
        axis: vec(0, 0, 1),
        radius: 6,
        d1: [1, 0],
        d2: [0, 1],
        convex: false
      },
      'fillet',
      2
    );
    const xBar = (2 * (5 / 6 - Math.PI / 4)) / (1 - Math.PI / 4);
    expect(added).toBeCloseTo(
      4 * (1 - Math.PI / 4) * 2 * Math.PI * (6 + xBar),
      9
    );
  });

  it('closes an equal-radius corner as a sphere octant and integrates a tilted post', () => {
    // A convex fillet of radius r round a circular edge of radius r (a
    // corner round meeting an equal-radius bottom blend) adds a quarter turn
    // per corner; with the round's own column the corner is a sphere octant,
    // so the full turn removes π r³/3 on its own.
    expect(convexCircleChange(4, 'fillet', 4)).toBeCloseTo(
      (-Math.PI * 4 ** 3) / 3,
      9
    );
    // The integrated overlap path agrees with the closed-form one when the
    // post stands upright.
    const upright = initialModel(
      TWIN_VARIANTS.find((variant) => variant.id === 'tilted-unblended')!
    );
    const closed = expectedVolume({ ...upright, tilt: undefined });
    const integrated = expectedVolume({
      ...upright,
      tilt: { x: 0, y: 0, z: 0 }
    });
    expect(Math.abs(integrated.volume - closed.volume)).toBeLessThan(
      Math.max(4 * integrated.error, 1e-6 * closed.volume)
    );
  });

  it('keeps cell ids unique and splits the matrix between CI and the campaign', () => {
    const ids = allCells().map((cell) => cell.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(smokeCells().length + campaignCells().length).toBe(ids.length);
    const twins = importedTwinCells().map((cell) => cell.id);
    expect(new Set(twins).size).toBe(twins.length);
    expect(twinSmokeCells().length + twinCampaignCells().length).toBe(
      twins.length
    );
  });
});

defineLedgerSuite(
  'K10 combination matrix: CI slice',
  new URL('./combination-matrix.ledger.json', import.meta.url),
  smokeCells()
);

defineLedgerSuite(
  'K10 imported twin: CI slice',
  new URL('./combination-matrix.imported-twin.ledger.json', import.meta.url),
  twinSmokeCells(),
  { run: runTwinCell, reproduction: twinReproduction }
);
