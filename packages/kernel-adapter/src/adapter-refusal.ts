/**
 * The adapter's own refusals, typed at their throw sites.
 *
 * Not every refusal a person reads comes from the kernel. The adapter
 * refuses on its own account too: a union whose result fails the strict
 * solid gate, operands that never touch, a saved edge that no longer
 * resolves, a size the feature cannot take. Those used to reach the user as
 * a bare sentence, so the K10 ledgers recorded them as `untyped-refusal` and
 * every consumer that wanted to branch on them — analytics buckets, the
 * refusal harvest, a card choosing its route — had nothing but the English.
 *
 * Each one now carries a stable code from {@link ADAPTER_REFUSALS}, with a
 * family and a category from the kernel's own taxonomy, on the same
 * {@link KernelRefusal} seam (and `FeatureWarning.kernelRefusal` field) the
 * kernel-typed families use. The sentence is unchanged and remains product
 * copy; the code is the branchable field.
 *
 * Codes are lower-case words joined by underscores with no digits, the shape
 * the analytics contract accepts (`REFUSAL_CODE_PATTERN`).
 */
import {
  KernelRefusal,
  type KernelRefusalCategory,
  type KernelRefusalFamily,
  type KernelRefusalRecord
} from './kernel-refusal';

interface AdapterRefusalSpec {
  family: KernelRefusalFamily;
  category: KernelRefusalCategory;
  /** The kernel operation, for a family that names one (booleans do). */
  operation?: string;
}

/**
 * Every adapter-raised refusal code, once, with its classification.
 *
 * - `union_not_solid`: the fuse returned a body that fails the strict
 *   closed / consistently oriented solid gate.
 * - `union_disconnected`: the selected solids form separate groups, so a
 *   union would not be one body.
 * - `union_dropped_operand`: the fuse silently lost one of its operands.
 * - `reference_missing`: a saved edge or face no longer resolves on the body.
 * - `reference_positional`: a saved reference is a pre-ADR-011 traversal
 *   ordinal that cannot be resolved safely.
 * - `reference_ambiguous`: a saved reference matches more than one entity.
 * - `edge_modifier_size_not_positive`: a fillet or chamfer size of zero or
 *   less.
 * - `edge_modifier_refused`: a fillet or chamfer neither the kernel built
 *   nor the adapter accepted, with no typed kernel refusal behind it (an
 *   acceptance rule declined the kernel's result).
 * - `blend_radius_negative`: a blend resize to a negative radius.
 * - `radius_not_positive`: a cylindrical-face resize to a radius of zero or
 *   less.
 */
export const ADAPTER_REFUSALS = {
  union_not_solid: {
    family: 'boolean',
    category: 'invalid_topology',
    operation: 'fuse'
  },
  union_disconnected: {
    family: 'boolean',
    category: 'invalid_input',
    operation: 'fuse'
  },
  union_dropped_operand: {
    family: 'boolean',
    category: 'invalid_topology',
    operation: 'fuse'
  },
  reference_missing: { family: 'reference', category: 'invalid_input' },
  reference_positional: { family: 'reference', category: 'invalid_input' },
  reference_ambiguous: { family: 'reference', category: 'invalid_input' },
  edge_modifier_size_not_positive: {
    family: 'blend',
    category: 'invalid_input'
  },
  edge_modifier_refused: { family: 'blend', category: 'quality_refused' },
  blend_radius_negative: { family: 'direct-edit', category: 'invalid_input' },
  radius_not_positive: { family: 'direct-edit', category: 'invalid_input' }
} as const satisfies Record<string, AdapterRefusalSpec>;

export type AdapterRefusalCode = keyof typeof ADAPTER_REFUSALS;

/**
 * A refusal the adapter raised itself, as a typed error.
 *
 * `message` is the sentence the user reads, exactly as before; `kernelCode`
 * holds the adapter's code because no kernel code exists for it.
 */
export class AdapterRefusal extends KernelRefusal {
  readonly adapterCode: AdapterRefusalCode;
  readonly operation?: string;

  constructor(code: AdapterRefusalCode, message: string, cause?: unknown) {
    const spec: AdapterRefusalSpec = ADAPTER_REFUSALS[code];
    super({
      family: spec.family,
      category: spec.category,
      kernelCode: code,
      kernelMessage: message,
      reason: message,
      message,
      ...(cause === undefined ? {} : { cause })
    });
    this.name = 'AdapterRefusal';
    this.adapterCode = code;
    if (spec.operation !== undefined) {
      this.operation = spec.operation;
    }
  }
}

/**
 * The warning record for an adapter refusal raised as a warning rather than
 * thrown (the union gates push their sentence and keep building).
 */
export function adapterRefusalRecord(
  code: AdapterRefusalCode
): KernelRefusalRecord {
  const spec: AdapterRefusalSpec = ADAPTER_REFUSALS[code];
  return {
    family: spec.family,
    ...(spec.operation !== undefined ? { operation: spec.operation } : {}),
    category: spec.category,
    code
  };
}
