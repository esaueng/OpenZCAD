import type { SelectionFilter } from '@openzcad/viewport';
import type { ToolId } from './tools';

/**
 * The filter a tool implies while it is armed.
 *
 * Arming Fillet and then having to fight the face in front of an edge is the
 * kind of friction that makes a tool feel unfinished — the tool already said
 * what it wants. Tools that take whole bodies do the same for bodies, and
 * Sketch wants the planar face it will attach to.
 *
 * Tools not listed here place new geometry rather than consume a selection,
 * so they leave picking alone.
 */
const FILTER_BY_TOOL: Partial<Record<ToolId, SelectionFilter>> = {
  fillet: 'edge',
  chamfer: 'edge',
  union: 'body',
  subtract: 'body',
  intersect: 'body',
  transform: 'body',
  mirror: 'body',
  shell: 'face',
  'solid-offset': 'body',
  draft: 'face',
  thicken: 'face',
  'linear-pattern': 'body',
  'circular-pattern': 'body',
  sketch: 'face',
  extrude: 'sketch',
  revolve: 'sketch',
  loft: 'sketch',
  sweep: 'sketch',
  'helical-sweep': 'sketch'
};

export function inferredSelectionFilter(tool: ToolId | null): SelectionFilter {
  return (tool && FILTER_BY_TOOL[tool]) ?? 'any';
}

/**
 * The filter picking should actually use.
 *
 * A filter chosen by hand outranks the tool's, and survives arming one: a
 * user who narrowed to edges on purpose did not ask to be overruled. Clearing
 * the manual choice hands control back to the tool.
 */
export function effectiveSelectionFilter(
  manual: SelectionFilter | null,
  tool: ToolId | null
): SelectionFilter {
  return manual ?? inferredSelectionFilter(tool);
}
