import type {
  DocumentNode,
  QuantityExpressionDimension,
  QuantityLeaf,
  QuantityMapShape,
  SwitchQuantity
} from '@openzcad/shared';
import {
  FEATURE_QUANTITIES,
  PARAMETER_QUANTITIES,
  SKETCH_NODE_QUANTITIES,
  SKETCH_OBJECT_QUANTITIES,
  quantityExpressionDimension,
  walkQuantities
} from '@openzcad/shared';

/**
 * What a field holds (F05): a length, an angle in degrees, a unit-free
 * number, or `null` when no quantity rule applies (direction components,
 * a radians field, an on/off condition).
 */
export type ExpressionFieldDimension = QuantityExpressionDimension;

/** Where a visited expression is stored: its holding object and key. */
export interface ExpressionFieldSite {
  container: object;
  key: string;
}

type Rewrite = (
  expression: string,
  dimension: ExpressionFieldDimension,
  site: ExpressionFieldSite
) => string;

function visit(
  value: object,
  map: QuantityMapShape | SwitchQuantity<never>,
  rewrite: Rewrite
): void {
  walkQuantities(
    value,
    map,
    (leaf: QuantityLeaf) => {
      if (leaf.role !== 'expression' || typeof leaf.value !== 'string') return;
      const next = rewrite(
        leaf.value,
        quantityExpressionDimension(leaf.quantity),
        { container: leaf.holder, key: String(leaf.key) }
      );
      // Compared with what the field holds now, as before the registry: a
      // callback may itself have written through `site`.
      if (next !== leaf.holder[leaf.key]) leaf.holder[leaf.key] = next;
    },
    [],
    true
  );
}

/**
 * Visits only authored expression fields; ids, enums, text and witnesses are
 * literals. Which fields those are, and what each measures, is the I03
 * quantity registry's (`@openzcad/shared` `FEATURE_QUANTITIES` and
 * siblings): classify a new field there, not here.
 */
export function rewriteNodeExpressions(
  node: DocumentNode,
  rewrite: Rewrite
): void {
  if (node.kind === 'feature') visit(node.data, FEATURE_QUANTITIES, rewrite);
  else if (node.kind === 'sketch-object')
    visit(node.data, SKETCH_OBJECT_QUANTITIES, rewrite);
  else if (node.kind === 'parameter')
    visit(node, { expression: PARAMETER_QUANTITIES.expression }, rewrite);
  else if (node.kind === 'sketch') visit(node, SKETCH_NODE_QUANTITIES, rewrite);
}
