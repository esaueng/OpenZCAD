import { describe, expect, it } from 'vitest';
import type { RemusKernel } from './remus-runtime';
import { railEndScale } from './exact-profile-builders';
import { kernelRefusalOf } from './kernel-refusal';

/**
 * M04: the checks a straight guide rail must pass before an exact sweep
 * follows it, on straight edges stubbed as the kernel reports them. Each
 * case moves or skews one end and expects the verdict a model at the origin
 * would get.
 */
type P = [number, number, number];

function kernelOf(lines: [P, P][]): RemusKernel {
  return {
    getNurbsCurveData: (edge: number) =>
      JSON.stringify({
        degree: 1,
        knots: [0, 0, 1, 1],
        controlPoints: lines[edge]!,
        weights: [1, 1]
      })
  } as unknown as RemusKernel;
}

/** Path along +Z from the profile plane z = `z0`, rail beside it in XZ. */
function scaleOf(path: [P, P], rail: [P, P], offset: P = [0, 0, 0]) {
  const move = (p: P): P => [
    p[0] + offset[0],
    p[1] + offset[1],
    p[2] + offset[2]
  ];
  const kernel = kernelOf([
    [move(path[0]), move(path[1])],
    [move(rail[0]), move(rail[1])]
  ]);
  return railEndScale(kernel, [0], [1], {
    origin: { x: offset[0], y: offset[1], z: offset[2] },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 }
  } as never);
}

function refusalCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    const refusal = kernelRefusalOf(error);
    expect(refusal?.category).toBe('unsupported');
    return refusal?.kernelCode;
  }
  return undefined;
}

describe('exact sweep rail checks (M04)', () => {
  it('reads the end scale from a rail beside the path', () => {
    expect(
      scaleOf(
        [
          [0, 0, 0],
          [0, 0, 20]
        ],
        [
          [2, 0, 0],
          [4, 0, 20]
        ]
      )
    ).toBeCloseTo(2, 12);
  });

  it('refuses a path and rail that start off the profile plane, typed', () => {
    expect(
      refusalCode(() =>
        scaleOf(
          [
            [0, 0, 5],
            [0, 0, 25]
          ],
          [
            [2, 0, 5],
            [4, 0, 25]
          ]
        )
      )
    ).toBe('sweep-rail:off-profile-plane');
  });

  it('gives the same verdicts ten million units from the origin', () => {
    const far: P = [10_000_000, 0, 0];
    // A rail short at both ends is refused wherever the model sits: its
    // start is off the profile's plane, and a rail short only at the far end
    // is short.
    expect(
      refusalCode(() =>
        scaleOf(
          [
            [0, 0, 0],
            [0, 0, 20]
          ],
          [
            [1, 0, 0.5],
            [1, 0, 19.5]
          ],
          far
        )
      )
    ).toBe('sweep-rail:off-profile-plane');
    expect(
      refusalCode(() =>
        scaleOf(
          [
            [0, 0, 0],
            [0, 0, 20]
          ],
          [
            [1, 0, 0],
            [1, 0, 19.5]
          ],
          far
        )
      )
    ).toBe('sweep-rail:short-rail');
    // A full-length rail half a unit off the path is followed there too.
    expect(
      scaleOf(
        [
          [0, 0, 0],
          [0, 0, 20]
        ],
        [
          [0.5, 0, 0],
          [0.75, 0, 20]
        ],
        far
      )
    ).toBeCloseTo(1.5, 9);
  });

  it('refuses a rail skewed a tenth of a unit out of the path’s plane', () => {
    expect(
      refusalCode(() =>
        scaleOf(
          [
            [0, 0, 0],
            [0, 0, 20]
          ],
          [
            [1_000_000, 0, 0],
            [2_000_000, 0.1, 20]
          ]
        )
      )
    ).toBe('sweep-rail:skew-rail');
  });

  it('refuses a rail skewed a thousandth of a unit along a long path', () => {
    expect(
      refusalCode(() =>
        scaleOf(
          [
            [0, 0, 0],
            [0, 0, 10_000]
          ],
          [
            [0.11, 0, 0],
            [0.11, 0.0009, 10_000]
          ]
        )
      )
    ).toBe('sweep-rail:skew-rail');
  });

  it('refuses a rail eight millionths short at the origin and far from it alike', () => {
    for (const offset of [
      [0, 0, 0],
      [10_000_000, 0, 0]
    ] as P[]) {
      expect(
        refusalCode(() =>
          scaleOf(
            [
              [0, 0, 0],
              [0, 0, 20]
            ],
            [
              [2, 0, 0],
              [4, 0, 19.999992]
            ],
            offset
          )
        )
      ).toBe('sweep-rail:short-rail');
    }
  });

  it('refuses a curved path and a curved rail as unsupported', () => {
    const kernel = {
      getNurbsCurveData: () =>
        JSON.stringify({
          degree: 2,
          knots: [0, 0, 0, 1, 1, 1],
          controlPoints: [
            [0, 0, 0],
            [5, 0, 10],
            [0, 0, 20]
          ],
          weights: [1, 1, 1]
        })
    } as unknown as RemusKernel;
    expect(
      refusalCode(() =>
        railEndScale(kernel, [0], [0], {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 1 }
        } as never)
      )
    ).toBe('sweep-rail:curved-path');
  });
});
