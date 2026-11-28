import {
  solveAssembly,
  transformToMatrix4,
  type AssemblyInterferenceOperand,
  type AssemblyInterferencePair,
  type AssemblyInterferenceReport,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import { assemblyComponentBodies, assemblyRowDrawnParts } from './assembly';
import { isLiveAssemblyBody } from './assembly-bom';

/**
 * AS04: the parts an interference check reads, in display order, each with
 * the model's live body it stands for; the rest are `missing`.
 *
 * A part whose own Configuration names another row than the model's active
 * one (`assemblyRowDrawnParts`) is always among them: its row decides what
 * it shows, and only an exact build of that row can say what that is, so
 * the active row building no body for it does not make it missing. The
 * check resolves such a part's geometry from its row (#2388).
 */
export function assemblyCheckComponents(
  document: ProjectDocument,
  isLive: (bodyId: BodyId) => boolean = (bodyId) =>
    isLiveAssemblyBody(document, bodyId)
): {
  components: { componentId: string; bodyId: BodyId }[];
  missing: string[];
} {
  const set = document.assembly;
  if (!set) return { components: [], missing: [] };
  const bodies = assemblyComponentBodies(document, isLive);
  // No row is built here: every part naming another row comes back pending.
  const fromRow = new Map(
    assemblyRowDrawnParts(
      document,
      () => undefined,
      (_built, bodyId) => isLive(bodyId)
    ).map((part) => [part.componentId, part])
  );
  const components: { componentId: string; bodyId: BodyId }[] = [];
  const missing: string[] = [];
  for (const component of set.components) {
    const bodyId =
      bodies.get(component.id) ??
      fromRow.get(component.id)?.componentBodyId ??
      null;
    if (bodyId) components.push({ componentId: component.id, bodyId });
    else missing.push(component.id);
  }
  return { components, missing };
}

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
  const { components, missing } = assemblyCheckComponents(document, isLive);
  const operands: AssemblyInterferenceOperand[] = [];
  for (const { componentId, bodyId } of components) {
    const pose = solution.poses.get(componentId);
    if (!pose) {
      missing.push(componentId);
      continue;
    }
    operands.push({ componentId, bodyId, matrix: transformToMatrix4(pose) });
  }
  // Display order, as the parts list has them.
  const order = new Map(set.components.map((c, index) => [c.id, index]));
  missing.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
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
