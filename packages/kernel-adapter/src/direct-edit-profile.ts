/** Opt-in worker diagnostics. No kernel methods are wrapped outside a capture. */
export interface DirectEditProfile {
  elapsedMs: number;
  stages: Record<string, { calls: number; ms: number }>;
}

let active: DirectEditProfile | undefined;

export function profileDirectEditStage<T>(name: string, run: () => T): T {
  if (!active) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    const ended = performance.now();
    const stage = (active.stages[name] ??= { calls: 0, ms: 0 });
    stage.calls++;
    stage.ms += ended - started;
    if (ended - started >= 1)
      performance.measure(`oz.direct.${name}`, { start: started, end: ended });
  }
}

export function beginDirectEditProfile(
  prototype: object
): () => DirectEditProfile {
  const started = performance.now();
  const profile: DirectEditProfile = { elapsedMs: 0, stages: {} };
  active = profile;
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    if (name === 'constructor' || typeof descriptor.value !== 'function')
      continue;
    descriptors.set(name, descriptor);
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: function (this: object, ...args: unknown[]) {
        return profileDirectEditStage(`kernel.${name}`, () =>
          original.apply(this, args)
        );
      }
    });
  }
  return () => {
    for (const [name, descriptor] of descriptors)
      Object.defineProperty(prototype, name, descriptor);
    active = undefined;
    profile.elapsedMs = performance.now() - started;
    return profile;
  };
}
