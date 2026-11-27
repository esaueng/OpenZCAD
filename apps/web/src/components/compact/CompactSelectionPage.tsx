import { Info, X } from 'lucide-react';
import { verbIcon } from '../SelectionRail';
import type {
  CompactSelectionAction,
  CompactSelectionSheet
} from './compactSlots';
import { MenuList, type MenuRow } from './CompactMenuList';

function rows(
  actions: readonly CompactSelectionAction[],
  done: () => void
): MenuRow[] {
  return actions.map((action) => ({
    id: action.id,
    label: action.label,
    icon: action.icon,
    disabledReason: action.disabledReason ?? null,
    run: () => {
      done();
      action.run();
    }
  }));
}

/**
 * The selection sheet (U12 slice 5), opened from the selection chip: the
 * pick's verbs as the verb rail offers them, the picks a double-click makes
 * on the regular stage (Select body, Select connected), the selection
 * filter, and the pick's properties, which the inspector shows as the
 * sheet's own content.
 */
export function CompactSelectionPage({
  selection,
  onDetails,
  onClear,
  done
}: {
  selection: CompactSelectionSheet | null;
  /** Shows the inspector's properties for the pick, where it has them. */
  onDetails: (() => void) | null;
  onClear: (() => void) | null;
  /** Puts the page away before an action runs. */
  done(): void;
}) {
  const verbs = selection?.verbs ?? [];
  const picks = selection?.picks ?? [];
  const filter = selection?.filter ?? null;
  return (
    <div className="compact-selection-page">
      {verbs.length > 0 ? (
        <div className="compact-verb-grid" role="group" aria-label="Verbs">
          {verbs.map((verb) => (
            <button
              key={verb.id}
              type="button"
              className="compact-verb"
              aria-label={verb.label}
              aria-pressed={verb.pressed || undefined}
              disabled={verb.disabled}
              title={verb.title}
              onClick={() => {
                done();
                selection?.onVerb(verb.id);
              }}
            >
              <span className="compact-verb-icon" aria-hidden="true">
                {verbIcon(verb)}
              </span>
              <span className="compact-verb-label" aria-hidden="true">
                {verb.label}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <MenuList
        label="Selection"
        rows={[
          ...rows(picks, done),
          ...(onDetails
            ? [
                {
                  id: 'details',
                  label: 'Properties',
                  icon: <Info size={18} />,
                  run: onDetails
                }
              ]
            : []),
          ...(onClear
            ? [
                {
                  id: 'clear',
                  label: 'Clear selection',
                  icon: <X size={18} />,
                  run: onClear
                }
              ]
            : [])
        ]}
      />
      {filter ? (
        <div
          className="compact-filter"
          role="radiogroup"
          aria-label="Selection filter"
        >
          {filter.options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              className="compact-filter-option"
              aria-checked={option.id === filter.current}
              onClick={() => filter.onChange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
