import type { UnitSystem } from '@openzcad/shared';

export interface UnionBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface UnionSolid<T> {
  solid: T;
  bounds: UnionBounds;
}

export interface UnionConnectivity {
  connected: boolean;
  componentCount: number;
  closestGap: number | null;
  contactTolerance: number;
}

interface CandidatePair {
  left: number;
  right: number;
  lowerBound: number;
  distance?: number;
}

function axisGap(
  leftMin: number,
  leftMax: number,
  rightMin: number,
  rightMax: number
): number {
  return Math.max(leftMin - rightMax, rightMin - leftMax, 0);
}

function boundsDistance(left: UnionBounds, right: UnionBounds): number {
  return Math.hypot(
    axisGap(left.min.x, left.max.x, right.min.x, right.max.x),
    axisGap(left.min.y, left.max.y, right.min.y, right.max.y),
    axisGap(left.min.z, left.max.z, right.min.z, right.max.z)
  );
}

function modelScale<T>(solids: readonly UnionSolid<T>[]): number {
  if (solids.length === 0) {
    return 1;
  }
  const bounds = solids.reduce<UnionBounds>(
    (combined, entry) => ({
      min: {
        x: Math.min(combined.min.x, entry.bounds.min.x),
        y: Math.min(combined.min.y, entry.bounds.min.y),
        z: Math.min(combined.min.z, entry.bounds.min.z)
      },
      max: {
        x: Math.max(combined.max.x, entry.bounds.max.x),
        y: Math.max(combined.max.y, entry.bounds.max.y),
        z: Math.max(combined.max.z, entry.bounds.max.z)
      }
    }),
    {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    }
  );
  return Math.max(
    Math.hypot(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    ),
    Math.abs(bounds.min.x),
    Math.abs(bounds.min.y),
    Math.abs(bounds.min.z),
    Math.abs(bounds.max.x),
    Math.abs(bounds.max.y),
    Math.abs(bounds.max.z),
    1
  );
}

/**
 * Numerical contact tolerance only. This is deliberately much tighter than
 * modeling/healing tolerances: Union must never bridge a real empty gap.
 */
function contactTolerance<T>(solids: readonly UnionSolid<T>[]): number {
  return Number.EPSILON * modelScale(solids) * 128;
}

/**
 * Finds whether every solid lump participates in one touching/overlapping
 * graph. Bounding-box lower bounds prune exact kernel distance calls, which
 * keeps patterned bodies bounded while preserving exact contact decisions.
 * `exactOverlap` covers kernels whose distance query reports penetration
 * depth instead of zero for intersecting solids.
 */
export function analyzeUnionConnectivity<T>(
  solids: readonly UnionSolid<T>[],
  exactDistance: (left: T, right: T) => number,
  exactOverlap?: (left: T, right: T) => boolean
): UnionConnectivity {
  if (solids.length <= 1) {
    return {
      connected: true,
      componentCount: solids.length,
      closestGap: null,
      contactTolerance: contactTolerance(solids)
    };
  }

  const tolerance = contactTolerance(solids);
  const parent = solids.map((_, index) => index);
  const rank = solids.map(() => 0);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    let current = index;
    while (parent[current] !== current) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    if (rank[leftRoot]! < rank[rightRoot]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parent[rightRoot] = leftRoot;
    if (rank[leftRoot] === rank[rightRoot]) {
      rank[leftRoot] = rank[leftRoot]! + 1;
    }
  };
  const distanceFor = (pair: CandidatePair): number => {
    if (pair.distance === undefined) {
      const distance = exactDistance(
        solids[pair.left]!.solid,
        solids[pair.right]!.solid
      );
      if (!Number.isFinite(distance) || distance < 0) {
        throw new Error(
          'The geometry kernel returned an invalid solid distance.'
        );
      }
      pair.distance = distance;
    }
    return pair.distance;
  };

  const pairs: CandidatePair[] = [];
  for (let left = 0; left < solids.length; left += 1) {
    for (let right = left + 1; right < solids.length; right += 1) {
      pairs.push({
        left,
        right,
        lowerBound: boundsDistance(solids[left]!.bounds, solids[right]!.bounds)
      });
    }
  }
  pairs.sort((left, right) => left.lowerBound - right.lowerBound);

  for (const pair of pairs) {
    if (pair.lowerBound > tolerance) {
      break;
    }
    if (
      distanceFor(pair) <= tolerance ||
      exactOverlap?.(
        solids[pair.left]!.solid,
        solids[pair.right]!.solid
      ) === true
    ) {
      union(pair.left, pair.right);
    }
  }

  const componentCount = new Set(solids.map((_, index) => find(index))).size;
  if (componentCount === 1) {
    return {
      connected: true,
      componentCount,
      closestGap: null,
      contactTolerance: tolerance
    };
  }

  let closestGap = Infinity;
  for (const pair of pairs) {
    if (pair.lowerBound >= closestGap) {
      break;
    }
    if (find(pair.left) === find(pair.right)) {
      continue;
    }
    closestGap = Math.min(closestGap, distanceFor(pair));
  }

  return {
    connected: false,
    componentCount,
    closestGap: Number.isFinite(closestGap) ? closestGap : null,
    contactTolerance: tolerance
  };
}

function formatGap(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 0.001 || magnitude >= 100_000)) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(6)).toString();
}

export function disconnectedUnionWarning(
  connectivity: UnionConnectivity,
  units: UnitSystem
): string {
  const gap =
    connectivity.closestGap === null
      ? ''
      : ` The closest gap is ${formatGap(connectivity.closestGap)} ${units}.`;
  return `Union does not fill empty space. The selected solids form ${connectivity.componentCount} disconnected groups.${gap} Move or extend a body until every solid touches or overlaps.`;
}
