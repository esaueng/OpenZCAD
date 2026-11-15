import {
  solveAssembly,
  transformToMatrix4,
  type AssemblyInterferenceOperand,
  type AssemblyInterferencePair,
  type AssemblyInterferenceReport,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import { assemblyComponentBodies } from './assembly';
import { isLiveAssemblyBody } from './assembly-bom';

/**
 * AS04 input: every component of the saved assembly at its solved pose (the
 * stored joint values, never an exploded offset or a transient drag), with the
 * live body it shows. Interference is a property of the assembled product,
 * so the exploded view, which only pulls parts apart for presentation, never
 * enters it. A component whose body is gone is reported in `missing` rather
 * than dropped, so a broken reference never reads as "no interference".
 */
export function assemblyInterferenceOperands(
  document: ProjectDocument,
  isLive: (bodyId: BodyId) => boolean = (bodyId) =>
    isLiveAssemblyBody(document, bodyId)
): { operands: AssemblyInterferenceOperand[]; missing: string[] } {
  const set = document.assembly;
  if (!set) return { operands: [], missing: [] };
  const solution = solveAssembly(set);
  const bodies = assemblyComponentBodies(document, isLive);
  const operands: AssemblyInterferenceOperand[] = [];
  const missing: string[] = [];
  for (const component of set.components) {
    const bodyId = bodies.get(component.id);
    const pose = solution.poses.get(component.id);
    if (!bodyId || !pose) {
      missing.push(component.id);
      continue;
    }
    operands.push({
      componentId: component.id,
      bodyId,
      matrix: transformToMatrix4(pose)
    });
  }
  return { operands, missing };
}

/**
 * The pairs that need attention first: interference (largest measured volume
 * first, unmeasured after), then unknowns, then contact; clear pairs keep
 * display order behind them. Stable, so equal pairs keep the kernel's order.
 */
export function sortInterferencePairs(
  pairs: readonly AssemblyInterferencePair[]
): AssemblyInterferencePair[] {
  const rank = (pair: AssemblyInterferencePair) => {
    const verdict = pair.verdict;
    if (verdict.kind === 'interference') return 0;
    if (verdict.kind === 'unknown') return 1;
    return verdict.touching === true ? 2 : 3;
  };
  return pairs
    .map((pair, index) => ({ pair, index }))
    .sort((left, right) => {
      const byRank = rank(left.pair) - rank(right.pair);
      if (byRank !== 0) return byRank;
      const a = left.pair.verdict;
      const b = right.pair.verdict;
      if (a.kind === 'interference' && b.kind === 'interference') {
        const volume = (b.volume ?? -1) - (a.volume ?? -1);
        if (volume !== 0) return volume;
      }
      return left.index - right.index;
    })
    .map(({ pair }) => pair);
}

/** Counts for a one-line summary. */
export function summarizeInterference(report: AssemblyInterferenceReport): {
  interfering: number;
  unknown: number;
  touching: number;
  clear: number;
  missing: number;
} {
  const summary = {
    interfering: 0,
    unknown: 0,
    touching: 0,
    clear: 0,
    missing: report.missing.length
  };
  for (const { verdict } of report.pairs) {
    if (verdict.kind === 'interference') summary.interfering += 1;
    else if (verdict.kind === 'unknown') summary.unknown += 1;
    else if (verdict.touching === true) summary.touching += 1;
    else summary.clear += 1;
  }
  return summary;
}
