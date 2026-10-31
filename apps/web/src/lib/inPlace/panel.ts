import type {
  InPlacePanelState,
  InPlaceToolSpec,
  OptionSpec,
  ValueSpec
} from './tools';

/**
 * One row of an in-place command's Options panel: a choice, a number, or a
 * point's coordinates side by side ("Corner X/Y/Z" as one "Corner" row).
 */
export type InPlacePanelRow =
  | { kind: 'option'; id: string }
  | { kind: 'value'; id: string }
  | {
      kind: 'vector';
      label: string;
      ids: readonly string[];
      /** Each field's own short name ("X"), in `ids` order. */
      axes: readonly string[];
    };

export interface InPlacePanelSectionView {
  label?: string;
  /** Folded shut until opened: rows set once and rarely changed. */
  collapsed?: boolean;
  rows: readonly InPlacePanelRow[];
}

/** Every option at its chosen or initial value, every value as a number. */
export function inPlacePanelState(
  spec: Pick<InPlaceToolSpec, 'options' | 'values'>,
  options: Readonly<Record<string, string>>,
  values: Readonly<Record<string, number>>
): InPlacePanelState {
  const chosen: Record<string, string> = {};
  for (const option of spec.options ?? []) {
    chosen[option.id] = options[option.id] ?? option.initial;
  }
  const numbers: Record<string, number> = {};
  for (const value of spec.values) {
    numbers[value.id] = values[value.id] ?? value.initial;
  }
  return { options: chosen, numbers };
}

const AXIS_LABEL = /^(.+) ([XYZ])$/u;

/**
 * The panel's rows as they stand: the spec's layout (or its options, then
 * its values), keeping an option or a value only while its `when` holds,
 * and a value with a handle only while that handle stands. `optionIds`
 * narrows the options to those the command offers now (an edit's locked
 * ones are not), and `labelOf` names a value as its chip does.
 */
export function inPlacePanelSections(
  spec: Pick<InPlaceToolSpec, 'options' | 'values' | 'layout'>,
  state: InPlacePanelState,
  handled: ReadonlySet<string>,
  optionIds: readonly string[] = (spec.options ?? []).map((o) => o.id),
  labelOf: (value: ValueSpec) => string = (value) => value.label
): InPlacePanelSectionView[] {
  const offered = new Set(optionIds);
  const optionById = new Map<string, OptionSpec>(
    (spec.options ?? []).map((option) => [option.id, option])
  );
  const valueById = new Map<string, ValueSpec>(
    spec.values.map((value) => [value.id, value])
  );
  const shown = (id: string): InPlacePanelRow | null => {
    const option = optionById.get(id);
    if (option) {
      return offered.has(id) && option.when?.(state) !== false
        ? { kind: 'option', id }
        : null;
    }
    const value = valueById.get(id);
    if (!value) return null;
    if (!value.inOptions && !handled.has(id)) return null;
    return value.when?.(state) === false ? null : { kind: 'value', id };
  };
  const layout = spec.layout ?? [
    {
      items: [
        ...(spec.options ?? []).map((option) => option.id),
        ...spec.values.map((value) => value.id)
      ]
    }
  ];
  // Whatever the layout leaves out still has a row, after the rest.
  const placed = new Set(layout.flatMap((section) => section.items));
  const rest = [
    ...(spec.options ?? []).map((option) => option.id),
    ...spec.values.map((value) => value.id)
  ].filter((id) => !placed.has(id));
  const sections = rest.length > 0 ? [...layout, { items: rest }] : layout;
  const out: InPlacePanelSectionView[] = [];
  for (const section of sections) {
    const rows: InPlacePanelRow[] = [];
    for (const id of section.items) {
      const row = shown(id);
      if (!row) continue;
      // A point's coordinates, one after another, share one row.
      const value = row.kind === 'value' ? valueById.get(id) : undefined;
      const axis = value ? AXIS_LABEL.exec(labelOf(value)) : null;
      const last = rows.at(-1);
      if (axis) {
        const prefix = axis[1]!;
        const name = axis[2]!;
        if (last?.kind === 'vector' && last.label === prefix) {
          rows[rows.length - 1] = {
            ...last,
            ids: [...last.ids, id],
            axes: [...last.axes, name]
          };
          continue;
        }
        if (last?.kind === 'value') {
          const previous = valueById.get(last.id);
          const before = previous ? AXIS_LABEL.exec(labelOf(previous)) : null;
          if (before && before[1] === prefix) {
            rows[rows.length - 1] = {
              kind: 'vector',
              label: prefix,
              ids: [last.id, id],
              axes: [before[2]!, name]
            };
            continue;
          }
        }
      }
      rows.push(row);
    }
    if (rows.length > 0) {
      out.push({
        ...(section.label ? { label: section.label } : {}),
        ...(section.collapsed ? { collapsed: true } : {}),
        rows
      });
    }
  }
  return out;
}

/** The step one arrow key or scrub notch moves a value by. */
export function inPlaceValueStep(value: ValueSpec, current: number): number {
  if (value.step !== undefined) return value.step;
  if (value.integer) return 1;
  if (value.unit === 'angle') return 1;
  return Math.abs(current) < 10 ? 0.1 : 1;
}
