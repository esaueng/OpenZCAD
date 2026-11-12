import type { BodyId, ProjectDocument } from '@openzcad/shared';
import { assemblyComponentBodies } from './assembly';

/**
 * AS03 bill of materials, derived from the assembly alone: no stored state,
 * no geometry, no kernel. One row per part, where a part is the live body a
 * component shows now (following the body's lineage, as the viewport does),
 * so components that resolve to one body count as one part with a quantity.
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
 * columns. Components whose body was deleted have no part to list and are
 * left out; the Parts list already flags them.
 */
export interface AssemblyBomInstance {
  componentId: string;
  name: string;
}

export interface AssemblyBomRow {
  /** 1-based position in the BOM. */
  item: number;
  quantity: number;
  /** The part's name: its body's name in the document. */
  name: string;
  /** Source identity: the live body every instance in this row shows. */
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
  const body = document.derived.bodyRepresentations[bodyId];
  return Boolean(body && !body.consumed);
}

export function deriveAssemblyBom(
  document: ProjectDocument,
  isLive: (bodyId: BodyId) => boolean = (bodyId) =>
    isLiveAssemblyBody(document, bodyId)
): AssemblyBom {
  const components = document.assembly?.components ?? [];
  if (components.length === 0) return { rows: [], totalQuantity: 0 };
  const resolved = assemblyComponentBodies(document, isLive);
  const bodyNames = new Map<BodyId, string>();
  for (const node of Object.values(document.nodes))
    if (node.kind === 'body') bodyNames.set(node.bodyId, node.name);
  const rows = new Map<BodyId, AssemblyBomRow>();
  for (const component of components) {
    const bodyId = resolved.get(component.id) ?? null;
    if (bodyId === null) continue;
    let row = rows.get(bodyId);
    if (!row) {
      const name =
        bodyNames.get(bodyId)?.trim() ||
        document.derived.bodyRepresentations[bodyId]?.name.trim() ||
        component.name;
      row = { item: rows.size + 1, quantity: 0, name, bodyId, instances: [] };
      rows.set(bodyId, row);
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

export const ASSEMBLY_BOM_CSV_HEADER =
  'item,quantity,part,instances,source_body';

/**
 * The BOM as CSV, one line per row after the header, `\n` line ends and no
 * trailing newline. Cells that a spreadsheet would read as a formula are
 * prefixed with an apostrophe, the same guard the measurement CSV uses.
 */
export function assemblyBomToCsv(bom: AssemblyBom): string {
  return [
    ASSEMBLY_BOM_CSV_HEADER,
    ...bom.rows.map((row) =>
      [
        String(row.item),
        String(row.quantity),
        csvCell(row.name),
        csvCell(row.instances.map((instance) => instance.name).join('; ')),
        csvCell(row.bodyId)
      ].join(',')
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
