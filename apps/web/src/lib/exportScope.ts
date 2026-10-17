/**
 * Which bodies an export writes. A selected exportable body exports alone;
 * otherwise every exportable body does, and bodies hidden in the viewport
 * are included only while `includeHidden` is on. Hidden is a viewing state,
 * so the default keeps them (an export has always written them), but the
 * count is reported so the choice is never silent. Bodies a failed history
 * step stands in for are withheld whatever the scope.
 */
export interface ExportScopeBody {
  bodyId: string;
  exportable: boolean;
  hidden: boolean;
  withheld: boolean;
}

export interface ExportScope {
  bodyIds: string[];
  /** All-bodies scope only: hidden bodies written, and hidden bodies left out. */
  hiddenIncluded: number;
  hiddenExcluded: number;
  /** Exportable bodies left out because their history step failed. */
  withheldIds: string[];
  selection: boolean;
}

export function exportScope(
  bodies: readonly ExportScopeBody[],
  selectedBodyId: string | null,
  includeHidden: boolean
): ExportScope {
  const exportable = bodies.filter((body) => body.exportable);
  const selected = exportable.find((body) => body.bodyId === selectedBodyId);
  if (selected) {
    return {
      bodyIds: selected.withheld ? [] : [selected.bodyId],
      hiddenIncluded: 0,
      hiddenExcluded: 0,
      withheldIds: selected.withheld ? [selected.bodyId] : [],
      selection: true
    };
  }
  const kept = exportable.filter((body) => includeHidden || !body.hidden);
  return {
    bodyIds: kept.filter((body) => !body.withheld).map((body) => body.bodyId),
    hiddenIncluded: kept.filter((body) => body.hidden && !body.withheld).length,
    // Withheld bodies count on neither side: including hidden bodies can
    // never add one, so it must not read as left out either.
    hiddenExcluded: exportable.filter(
      (body) => body.hidden && !body.withheld && !kept.includes(body)
    ).length,
    withheldIds: kept
      .filter((body) => body.withheld)
      .map((body) => body.bodyId),
    selection: false
  };
}

/** "all bodies (3, 1 hidden)" / "visible bodies (2, 1 hidden left out)". */
export function exportScopeLabel(scope: ExportScope): string {
  const count = scope.bodyIds.length;
  if (scope.hiddenExcluded > 0)
    return `visible bodies (${count}, ${scope.hiddenExcluded} hidden left out)`;
  return scope.hiddenIncluded > 0
    ? `all bodies (${count}, ${scope.hiddenIncluded} hidden)`
    : `all bodies (${count})`;
}
