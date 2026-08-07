import type { BodyMassProperties, Vector3 } from '@openzcad/shared';

/**
 * Reads the kernel's mass-properties result into a checked shape, or nothing.
 *
 * This exists as a boundary rather than a cast because the binding is typed
 * `any` and returns a JSON STRING. A consumer that casts gets a string whose
 * `.volume` is `undefined`, which formats as `0.00` — a solid part reporting
 * no mass, rendered as data rather than raised as an error. Every field is
 * therefore validated on the way in, and anything short of a complete,
 * all-finite result yields `null` so the caller renders an absence instead.
 *
 * Kept free of any kernel import so it can be exercised against a stub,
 * including the stub that returns an object instead of a string.
 */

/** The kernel surface this needs, narrowed to one call. */
export interface MassPropertiesSource {
  massProperties(solid: number): unknown;
}

function finiteNumbers(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) {
    return null;
  }
  const numbers: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return null;
    }
    numbers.push(entry);
  }
  return numbers;
}

function vectorAt(values: readonly number[], at: number): Vector3 {
  return { x: values[at]!, y: values[at + 1]!, z: values[at + 2]! };
}

/**
 * Parses whatever the binding returned. Accepts an already-parsed object so a
 * future binding change does not silently start yielding `null`, but does NOT
 * accept a string that fails to parse.
 */
function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && raw !== null
    ? (raw as Record<string, unknown>)
    : null;
}

export function readBodyMassProperties(
  kernel: MassPropertiesSource,
  solid: number
): BodyMassProperties | null {
  let raw: unknown;
  try {
    raw = kernel.massProperties(solid);
  } catch {
    // Documented to raise on a solid with no volume, where `kernel.volume`
    // merely answers zero. One unmeasurable body must not abort a rebuild.
    return null;
  }
  const payload = parsePayload(raw);
  if (!payload) {
    return null;
  }

  const centerOfMass = finiteNumbers(payload.centerOfMass, 3);
  const inertia = finiteNumbers(payload.inertia, 6);
  const principalMoments = finiteNumbers(payload.principalMoments, 3);
  const principalAxes = finiteNumbers(payload.principalAxes, 9);
  if (!centerOfMass || !inertia || !principalMoments || !principalAxes) {
    return null;
  }

  return {
    centerOfMass: vectorAt(centerOfMass, 0),
    inertia: [
      inertia[0]!,
      inertia[1]!,
      inertia[2]!,
      inertia[3]!,
      inertia[4]!,
      inertia[5]!
    ],
    principalMoments: [
      principalMoments[0]!,
      principalMoments[1]!,
      principalMoments[2]!
    ],
    // Row-major flat nine, split here so no consumer has to know that.
    principalAxes: [
      vectorAt(principalAxes, 0),
      vectorAt(principalAxes, 3),
      vectorAt(principalAxes, 6)
    ]
  };
}
