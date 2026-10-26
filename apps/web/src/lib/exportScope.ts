/**
 * Which bodies an export writes. A selected exportable body exports alone;
 * otherwise every visible exportable body does. Hidden bodies never export,
 * including a hidden selection. Bodies a failed history step stands in for
 * are withheld whatever the scope.
 */
export interface ExportScopeBody {
  bodyId: string;
  exportable: boolean;
  hidden: boolean;
  withheld: boolean;
}

export interface ExportScope {
  bodyIds: string[];
  /** All-bodies scope only: hidden bodies left out. */
  hiddenExcluded: number;
  /** Exportable bodies left out because their history step failed. */
  withheldIds: string[];
  selection: boolean;
}

export function exportScope(
  bodies: readonly ExportScopeBody[],
  selectedBodyId: string | null
): ExportScope {
  const exportable = bodies.filter((body) => body.exportable);
  const selected = exportable.find(
    (body) => body.bodyId === selectedBodyId && !body.hidden
  );
  if (selected) {
    return {
      bodyIds: selected.withheld ? [] : [selected.bodyId],
      hiddenExcluded: 0,
      withheldIds: selected.withheld ? [selected.bodyId] : [],
      selection: true
    };
  }
  const kept = exportable.filter((body) => !body.hidden);
  return {
    bodyIds: kept.filter((body) => !body.withheld).map((body) => body.bodyId),
    // Failed bodies are withheld independently of visibility.
    hiddenExcluded: exportable.filter((body) => body.hidden && !body.withheld)
      .length,
    withheldIds: kept
      .filter((body) => body.withheld)
      .map((body) => body.bodyId),
    selection: false
  };
}

/** "all bodies (3)" / "visible bodies (2, 1 hidden left out)". */
export function exportScopeLabel(scope: ExportScope): string {
  const count = scope.bodyIds.length;
  if (scope.hiddenExcluded > 0)
    return `visible bodies (${count}, ${scope.hiddenExcluded} hidden left out)`;
  return `all bodies (${count})`;
}

/** Recovery guidance when the current scope contains no exportable bodies. */
export function emptyExportMessage(
  scope: ExportScope | null,
  action = 'exporting'
): string {
  return `${scope && scope.hiddenExcluded > 0 ? 'Show' : 'Create'} a body before ${action}.`;
}
