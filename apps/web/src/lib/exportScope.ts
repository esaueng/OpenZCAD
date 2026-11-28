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
  /**
   * All-bodies scope only: saved bodies a failed feature built nothing for
   * (#2254). They are not on screen, so `exportScope` never sees them; the
   * caller adds them, and the label counts them as left out.
   */
  omittedIds?: string[];
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

/**
 * "all bodies (3)" / "visible bodies (2, 1 hidden left out)", and "2 of 3
 * bodies" / "visible bodies (2 of 3, 1 hidden left out)" when a failed
 * feature keeps a body out of the file (#2254): an all-bodies label must not
 * claim a body the export leaves out.
 */
export function exportScopeLabel(scope: ExportScope): string {
  const count = scope.bodyIds.length;
  const heldOut = exportScopeHeldOut(scope);
  const counted = heldOut > 0 ? `${count} of ${count + heldOut}` : `${count}`;
  if (scope.hiddenExcluded > 0)
    return `visible bodies (${counted}, ${scope.hiddenExcluded} hidden left out)`;
  return heldOut > 0 ? `${counted} bodies` : `all bodies (${count})`;
}

/** Bodies in scope that a failed feature keeps out of the file. */
export function exportScopeHeldOut(scope: ExportScope): number {
  return scope.withheldIds.length + (scope.omittedIds?.length ?? 0);
}

/** Recovery guidance when the current scope contains no exportable bodies. */
export function emptyExportMessage(
  scope: ExportScope | null,
  action = 'exporting'
): string {
  return `${scope && scope.hiddenExcluded > 0 ? 'Show' : 'Create'} a body before ${action}.`;
}

/**
 * Why nothing can be exported (#2205). When every body in scope is held out
 * by a failed feature, the reason names them and the failure, as the File
 * menu does; "Create a body" is for a scope that really has none.
 * `heldOutMessage` is the failed-history note for this scope.
 */
export function unavailableExportMessage(
  scope: ExportScope | null,
  heldOutMessage: string | null,
  action = 'exporting'
): string {
  return scope && scope.bodyIds.length === 0 && heldOutMessage
    ? heldOutMessage
    : emptyExportMessage(scope, action);
}
