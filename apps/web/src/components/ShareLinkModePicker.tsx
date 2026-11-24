import { useId } from 'react';
import type { ProjectShareLinkMode } from '@openzcad/shared';

const OPTIONS: readonly { mode: ProjectShareLinkMode; label: string }[] = [
  { mode: 'view', label: 'View' },
  { mode: 'tweak', label: 'Tweak' }
];

/** What a new link's visitors may do; Tweak includes everything View does. */
export const SHARE_LINK_MODE_HINT: Record<ProjectShareLinkMode, string> = {
  view: 'Visitors can look, measure and export.',
  tweak: 'Visitors can also change parameters. Their changes stay with them.'
};

/** What a link without history shares, in place of the mode's own line. */
export const SHARE_LINK_NO_HISTORY_HINT =
  'Visitors get the finished model only: no features, sketches or parameters. Bodies you hid start hidden. It stays as it is now until you update the link.';

/**
 * The access a new share link grants, as two native radios drawn as one
 * segmented control: arrow keys move between them, as in any radio group.
 */
export function ShareLinkModePicker({
  value,
  disabled = false,
  viewOnly = false,
  describedBy,
  onChange
}: {
  value: ProjectShareLinkMode;
  disabled?: boolean;
  /** A link without history has nothing to tweak: only View can be chosen. */
  viewOnly?: boolean;
  /** The line saying what the chosen access allows. */
  describedBy?: string;
  onChange(mode: ProjectShareLinkMode): void;
}) {
  const name = useId();
  return (
    <div
      className="sharing-link-mode"
      role="radiogroup"
      aria-label="Link access"
      aria-describedby={describedBy}
    >
      {OPTIONS.map((option) => (
        <label key={option.mode} className="sharing-link-mode-option">
          <input
            className="visually-hidden"
            type="radio"
            name={name}
            value={option.mode}
            checked={(viewOnly ? 'view' : value) === option.mode}
            disabled={disabled || (viewOnly && option.mode !== 'view')}
            onChange={() => onChange(option.mode)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
