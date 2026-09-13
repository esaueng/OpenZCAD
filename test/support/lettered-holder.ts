import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { translated } from './synthetic-holder';

/** Redistributable CAD glyphs: a concave L and a separate bar.
 * No font, proprietary outline, or private source enters the test corpus. */
export function letteredHolder(
  kernel: RemusKernel,
  options: {
    engraved?: boolean;
    unevenDepth?: boolean;
    bothArms?: boolean;
  } = {}
): number {
  const profile = kernel.makePolygon(
    new Float64Array([
      0, 0, 0, 60, 0, 0, 60, 32, 0, 52, 32, 0, 52, 8, 0, 8, 8, 0, 8, 32, 0, 0,
      32, 0
    ])
  );
  let holder = kernel.extrude(profile, 0, 0, 1, 20);
  const add = (side: number) => {
    const depth = 0.4;
    const x = side < 0 ? (options.engraved ? 7.6 : 8) : 51.6;
    const face = kernel.makePolygon(
      new Float64Array([
        x,
        12,
        7,
        x,
        17,
        7,
        x,
        17,
        9,
        x,
        14,
        9,
        x,
        14,
        13,
        x,
        12,
        13
      ])
    );
    const letter = kernel.extrude(face, 1, 0, 0, depth);
    const bar = translated(
      kernel,
      kernel.makeBox(options.unevenDepth ? 0.8 : depth, 4, 6),
      x,
      23,
      7
    );
    for (const glyph of [letter, bar])
      holder = options.engraved
        ? kernel.cut(holder, glyph)
        : kernel.fuse(holder, glyph);
  };
  add(-1);
  if (options.bothArms) add(1);
  if (kernel.validateSolid(holder) !== 0)
    throw new Error(
      'Synthetic lettering must be a valid exact solid: ' +
        JSON.stringify(kernel.validateSolidDetailed(holder))
    );
  return holder;
}
