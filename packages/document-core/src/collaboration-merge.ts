/**
 * Field-by-field three-way JSON merge behind live collaboration.
 *
 * The browser runs it (ADR-024 Phase 1): on a stale submission the room
 * replies with the base and its latest document, and the submitter merges and
 * resubmits. The room never merges, so it can later relay ciphertext.
 */

const MERGE_CONFLICT = Symbol('collaboration-merge-conflict');
type JsonMergeValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | JsonMergeValue[]
  | { [key: string]: JsonMergeValue };

function jsonComparison() {
  let remaining = 2_000_000;
  const memo = new WeakMap<object, WeakMap<object, boolean>>();
  const charge = () => {
    if (--remaining < 0)
      throw new Error('Collaboration merge exceeds its work limit.');
  };
  const same = (left: unknown, right: unknown): boolean => {
    charge();
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      return left.every((value, index) =>
        same(value ?? null, right[index] ?? null)
      );
    }
    if (!isRecord(left) || !isRecord(right)) return false;
    const cached = memo.get(left)?.get(right);
    if (cached !== undefined) return cached;
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter(
      (key) => right[key] !== undefined
    );
    const equal =
      keys.length === rightKeys.length &&
      keys.every(
        (key) => Object.hasOwn(right, key) && same(left[key], right[key])
      );
    let pairs = memo.get(left);
    if (!pairs) {
      pairs = new WeakMap();
      memo.set(left, pairs);
    }
    pairs.set(right, equal);
    return equal;
  };
  return { same, charge };
}

/** Structural JSON equality; `undefined` members count as absent. */
export function sameJson(left: unknown, right: unknown): boolean {
  return jsonComparison().same(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasJsonPrefix(
  values: unknown[],
  prefix: unknown[],
  same = sameJson
): boolean {
  return (
    values.length >= prefix.length &&
    prefix.every((value, index) => same(value, values[index]))
  );
}

function mergeJsonValue(
  base: unknown,
  latest: unknown,
  incoming: unknown,
  comparison: ReturnType<typeof jsonComparison>
): JsonMergeValue | typeof MERGE_CONFLICT {
  comparison.charge();
  const same = comparison.same;
  if (same(latest, incoming)) {
    return structuredClone(latest) as JsonMergeValue;
  }
  if (same(base, latest)) {
    return structuredClone(incoming) as JsonMergeValue;
  }
  if (same(base, incoming)) {
    return structuredClone(latest) as JsonMergeValue;
  }
  if (Array.isArray(base) && Array.isArray(latest) && Array.isArray(incoming)) {
    if (
      !hasJsonPrefix(latest, base, same) ||
      !hasJsonPrefix(incoming, base, same)
    ) {
      return MERGE_CONFLICT;
    }
    const merged = structuredClone(latest) as JsonMergeValue[];
    for (const value of incoming.slice(base.length)) {
      if (!merged.some((candidate) => same(candidate, value))) {
        merged.push(structuredClone(value) as JsonMergeValue);
      }
    }
    return merged;
  }
  if (isRecord(base) && isRecord(latest) && isRecord(incoming)) {
    const merged: { [key: string]: JsonMergeValue } = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(latest),
      ...Object.keys(incoming)
    ]);
    for (const key of keys) {
      const value = mergeJsonValue(
        base[key],
        latest[key],
        incoming[key],
        comparison
      );
      if (value === MERGE_CONFLICT) {
        return MERGE_CONFLICT;
      }
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    return merged;
  }
  return MERGE_CONFLICT;
}

/**
 * Merges two JSON objects that each descend from `base`, or returns null when
 * they changed the same value differently or the merge exceeds its work limit.
 */
export function mergeJsonRecords(
  base: Record<string, unknown>,
  latest: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> | null {
  let merged: JsonMergeValue | typeof MERGE_CONFLICT;
  try {
    merged = mergeJsonValue(base, latest, incoming, jsonComparison());
  } catch {
    return null;
  }
  return merged === MERGE_CONFLICT || !isRecord(merged) ? null : merged;
}
