import {
  ownEntry,
  isFeatureSuppressed,
  type BodyId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { assemblyComponentBodies } from './assembly';

/**
 * AS03 bill of materials, derived from the assembly alone: no stored state,
 * no geometry, no kernel. Components showing one body, or copies proven to
 * differ only by rigid placement, share a row. A mirror, scale or shape edit
 * starts a different part identity. Unknown provenance never groups parts.
 *
 * Deterministic by construction. Rows are ordered by the first component that
 * shows each part, in the assembly's saved display order; instances inside a
 * row keep that order too. Names come from the document's body nodes, so a
 * renamed body renames its row and nothing reads derived meshes, clocks or
 * locale. The same document gives the same rows on every machine and after
 * every save and reopen.
 *
 * The model carries no material or mass of its own (density is a per-browser
 * display preference, never document content), so the BOM has no such
 * columns. An unresolved component stays in the table and export as Missing;
 * a broken reference must never silently reduce the quantities.
 */
export interface AssemblyBomInstance {
  componentId: string;
  name: string;
}

export interface AssemblyBomRow {
  /** 1-based position in the BOM. */
  item: number;
  quantity: number;
  status: 'ready' | 'missing';
  /** The part's name: its body's name in the document. */
  name: string;
  /** First live body representing this part, or the unresolved body reference. */
  bodyId: BodyId;
  /** Components showing this part, in display order. */
  instances: AssemblyBomInstance[];
}

export interface AssemblyBom {
  rows: AssemblyBomRow[];
  /** Sum of every row's quantity. */
  totalQuantity: number;
}

/**
 * A body is live while it has a representation that no later feature
 * consumed: the rule the viewport and the Assemble panels use. It reads
 * `derived`, so it needs a rebuilt document; on one never rebuilt every
 * component's own body counts as missing until the rebuild lands.
 */
export function isLiveAssemblyBody(
  document: ProjectDocument,
  bodyId: BodyId
): boolean {
  const body = ownEntry(document.derived.bodyRepresentations, bodyId);
  return Boolean(body && !body.consumed);
}

/**
 * Shape identities at each point in history. A rigid copy inherits its
 * source's identity at the time it is made, not the source's final identity:
 * a later in-place scale or edit of that source cannot change an earlier
 * copy. Patterns hold an aggregate body, not separate assembly instances,
 * so they, mirrors and every other new result keep their own identity.
 * Expression-backed scales are conservative: only an absent or literal 1
 * proves a rigid placement without evaluating geometry or parameter units.
 */
function partIdentities(document: ProjectDocument): Map<BodyId, string> {
  const features = new Map(
    Object.values(document.nodes)
      .filter((node): node is FeatureNode => node.kind === 'feature')
      .map((node) => [node.featureId, node])
  );
  const identities = new Map<BodyId, string>();
  for (const id of document.featureOrder) {
    const feature = features.get(id);
    if (!feature || isFeatureSuppressed(feature)) continue;
    const data = feature.data;
    const own = `feature:${feature.featureId}`;
    if (data.featureKind === 'transform') {
      const rigid =
        data.transform.scale === undefined || data.transform.scale === 1;
      if (data.copy === true) {
        if (feature.bodyId) {
          identities.set(
            feature.bodyId,
            (rigid && identities.get(data.targetBodyId)) || own
          );
        }
      } else if (!rigid) {
        identities.set(data.targetBodyId, own);
      }
    } else if (feature.bodyId) {
      identities.set(feature.bodyId, own);
    } else if (data.featureKind === 'direct-edit') {
      identities.set(data.targetBodyId, own);
    }
  }
  return identities;
}

export function deriveAssemblyBom(
  document: ProjectDocument,
  isLive: (bodyId: BodyId) => boolean = (bodyId) =>
    isLiveAssemblyBody(document, bodyId)
): AssemblyBom {
  const components = document.assembly?.components ?? [];
  if (components.length === 0) return { rows: [], totalQuantity: 0 };
  const resolved = assemblyComponentBodies(document, isLive);
  const identities = partIdentities(document);
  const bodyNames = new Map<BodyId, string>();
  for (const node of Object.values(document.nodes))
    if (node.kind === 'body') bodyNames.set(node.bodyId, node.name);
  const rows = new Map<string, AssemblyBomRow>();
  for (const component of components) {
    const liveBodyId = resolved.get(component.id) ?? null;
    const bodyId = liveBodyId ?? component.bodyId;
    const status = liveBodyId === null ? 'missing' : 'ready';
    const key =
      status === 'missing'
        ? `missing:${bodyId}`
        : `ready:${identities.get(bodyId) ?? `body:${bodyId}`}`;
    let row = rows.get(key);
    if (!row) {
      const name =
        bodyNames.get(bodyId)?.trim() ||
        ownEntry(document.derived.bodyRepresentations, bodyId)?.name.trim() ||
        component.name;
      row = {
        item: rows.size + 1,
        quantity: 0,
        status,
        name,
        bodyId,
        instances: []
      };
      rows.set(key, row);
    }
    row.quantity += 1;
    row.instances.push({ componentId: component.id, name: component.name });
  }
  const list = [...rows.values()];
  return {
    rows: list,
    totalQuantity: list.reduce((sum, row) => sum + row.quantity, 0)
  };
}

/**
 * The BOM as a table: the one shape every reader of the BOM takes it in.
 * The Assemble sidebar, the CSV export and later drawing rows (a parts list
 * on a sheet, balloons pointing at a part's item number) read the same
 * columns, the same text and the same item numbers, so a part never has one
 * number on screen and another on paper.
 *
 * Cells are plain text, already formatted, with no locale: a table reader
 * lays them out and never reformats them. Column order is the CSV order;
 * `key` is the CSV header name and stays stable, `label` is what a person
 * reads. `numeric` cells align to the end.
 */
export type AssemblyBomColumnKey =
  'item' | 'quantity' | 'part' | 'instances' | 'source_body' | 'status';

export interface AssemblyBomColumn {
  key: AssemblyBomColumnKey;
  label: string;
  numeric: boolean;
}

export interface AssemblyBomTableRow {
  item: number;
  status: AssemblyBomRow['status'];
  /** Components this row counts, in display order. */
  componentIds: string[];
  cells: Record<AssemblyBomColumnKey, string>;
}

export interface AssemblyBomTable {
  columns: readonly AssemblyBomColumn[];
  rows: AssemblyBomTableRow[];
  totalQuantity: number;
  /** Item number of each component's row: what a balloon on a part shows. */
  itemByComponent: ReadonlyMap<string, number>;
}

export const ASSEMBLY_BOM_COLUMNS: readonly AssemblyBomColumn[] = [
  { key: 'item', label: 'Item', numeric: true },
  { key: 'quantity', label: 'Qty', numeric: true },
  { key: 'part', label: 'Part', numeric: false },
  { key: 'instances', label: 'Instances', numeric: false },
  { key: 'source_body', label: 'Source body', numeric: false },
  { key: 'status', label: 'Status', numeric: false }
];

export const ASSEMBLY_BOM_CSV_HEADER = ASSEMBLY_BOM_COLUMNS.map(
  (column) => column.key
).join(',');

export function assemblyBomTable(bom: AssemblyBom): AssemblyBomTable {
  const itemByComponent = new Map<string, number>();
  const rows = bom.rows.map((row) => {
    for (const instance of row.instances)
      itemByComponent.set(instance.componentId, row.item);
    return {
      item: row.item,
      status: row.status,
      componentIds: row.instances.map((instance) => instance.componentId),
      cells: {
        item: String(row.item),
        quantity: String(row.quantity),
        part: row.name,
        instances: row.instances.map((instance) => instance.name).join('; '),
        source_body: row.bodyId,
        status: row.status
      }
    };
  });
  return {
    columns: ASSEMBLY_BOM_COLUMNS,
    rows,
    totalQuantity: bom.totalQuantity,
    itemByComponent
  };
}

/**
 * The BOM as CSV, one line per row after the header, `\n` line ends and no
 * trailing newline. Cells that a spreadsheet would read as a formula are
 * prefixed with an apostrophe, the same guard the measurement CSV uses.
 */
export function assemblyBomToCsv(bom: AssemblyBom | AssemblyBomTable): string {
  const table = 'itemByComponent' in bom ? bom : assemblyBomTable(bom);
  return [
    ASSEMBLY_BOM_CSV_HEADER,
    ...table.rows.map((row) =>
      table.columns
        .map((column) =>
          column.numeric || column.key === 'status'
            ? row.cells[column.key]
            : csvCell(row.cells[column.key])
        )
        .join(',')
    )
  ].join('\n');
}

function csvCell(value: string): string {
  const text =
    /^[=+\-@\t\r]/.test(value) || /^\s+[=+\-@]/.test(value)
      ? `'${value}`
      : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
