import { vi } from 'vitest';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';

type Tessellate = RemusKernel['tessellateSolidGroupedBinary'];

/** Observe the shaded union gate and the active viewport binding on either package version. */
export function wrapGroupedMeshing(
  wrap: (
    original: Tessellate,
    ...args: Parameters<Tessellate>
  ) => ReturnType<Tessellate>
) {
  const proto = RemusKernel.prototype as RemusKernel & {
    tessellateSolidGroupedPositions?: Tessellate;
  };
  const restore: (() => void)[] = [];
  for (const name of [
    'tessellateSolidGroupedBinary',
    'tessellateSolidGroupedPositions'
  ] as const) {
    const original = proto[name];
    if (!original) continue;
    const spy = vi.spyOn(proto, name).mockImplementation(function (
      this: RemusKernel,
      ...args
    ) {
      return wrap(original.bind(this), ...args);
    });
    restore.push(() => spy.mockRestore());
  }
  return { mockRestore: () => restore.forEach((reset) => reset()) };
}
