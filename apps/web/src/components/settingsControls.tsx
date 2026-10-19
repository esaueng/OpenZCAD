import { useId, useState, type ReactNode } from 'react';

/**
 * The building blocks every Settings page is made of, so each page reads the
 * same way: a short header, then titled groups of rows, each row a name, at
 * most one line of hint, and one control on the right.
 */

export function Section({
  title,
  intro,
  wide = false,
  children
}: {
  title: string;
  intro: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`settings-section${wide ? ' settings-section-wide' : ''}`}
    >
      <header>
        <h2>{title}</h2>
        <p>{intro}</p>
      </header>
      {children}
    </section>
  );
}

/** A titled card of rows. `danger` frames actions that cannot be undone. */
export function Group({
  title,
  note,
  tone,
  children
}: {
  title?: string;
  /** A few words beside the title, such as when a group's controls pause. */
  note?: string;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <div className={`settings-group${tone ? ` ${tone}` : ''}`}>
      {title ? (
        <div className="settings-group-head">
          <h3>{title}</h3>
          {note ? <span>{note}</span> : null}
        </div>
      ) : null}
      <div className="settings-card">{children}</div>
    </div>
  );
}

export function SettingRow({
  title,
  hint,
  details,
  compact = false,
  children
}: {
  title: string;
  hint?: ReactNode;
  /** Longer copy kept one click away instead of on the page. */
  details?: { summary: string; body: ReactNode };
  /** A read-only fact: a single tight line with its value. */
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`setting-row${compact ? ' compact' : ''}`}>
      <div className="setting-copy">
        <strong className="setting-title">{title}</strong>
        {hint ? <small>{hint}</small> : null}
        {details ? (
          <details className="setting-details">
            <summary>{details.summary}</summary>
            <div>{details.body}</div>
          </details>
        ) : null}
      </div>
      {children === undefined ? null : (
        <div className="setting-control">{children}</div>
      )}
    </div>
  );
}

export function Toggle({
  checked,
  label,
  disabled = false,
  onChange
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true" />
    </label>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** The full name when the label is an abbreviation (mm, in). */
  title?: string;
}

/**
 * A short choice shown whole, so the current value and every alternative are
 * visible at once instead of behind a menu. Native radios keep the arrow keys
 * and the form semantics.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange
}: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  disabled?: boolean;
  onChange(value: T): void;
}) {
  const name = useId();
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} title={option.title}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            aria-label={option.title}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** A read-only value. `good` and `warning` add a coloured dot. */
export function Status({
  tone,
  title,
  children
}: {
  tone?: 'good' | 'warning';
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`settings-state${tone ? ` ${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

/** A used-of-limit bar with its figures. */
export function Meter({
  used,
  limit,
  label
}: {
  used: number;
  limit: number;
  label: string;
}) {
  const fraction = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <span
      className="settings-meter-bar"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={used}
    >
      <span style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
    </span>
  );
}

/**
 * A number field that lets the user type through values it would refuse.
 *
 * Bound straight to the setting, a keystroke that passed through an
 * out-of-range value (the "1" of "12" when the floor is 4, the "0" of "0.5")
 * was put back at once, so some values could not be typed at all and others
 * came out wrong. The field keeps its own text while focused, commits each
 * in-range value as it is typed, and on blur pulls anything else to the
 * nearest bound: the bounds storage normalizes to, so what the field shows is
 * what is kept rather than a value later swapped for the default.
 */
export function NumberSetting({
  value,
  min,
  max,
  step = 1,
  integer = false,
  unit = '',
  label,
  disabled = false,
  onCommit
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  unit?: string;
  label: string;
  disabled?: boolean;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const settle = (typed: number) => (integer ? Math.round(typed) : typed);
  // The step grid starts at `min` when there is one. A floor off that grid
  // (0.001 with step 0.1, 1024 with step 1000) made the default itself a step
  // mismatch and sent the arrow keys to 1.001, so it is left off then and the
  // clamp alone holds the floor.
  const minOnStepGrid = Math.abs(min / step - Math.round(min / step)) < 1e-9;
  return (
    <div className="settings-unit-input">
      <input
        className="settings-number"
        type="number"
        min={minOnStepGrid ? min : undefined}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        value={draft ?? String(value)}
        onChange={(event) => {
          const typed = event.currentTarget.valueAsNumber;
          setDraft(event.currentTarget.value);
          if (Number.isFinite(typed) && typed >= min && typed <= max) {
            onCommit(settle(typed));
          }
        }}
        onBlur={(event) => {
          const typed = event.currentTarget.valueAsNumber;
          setDraft(null);
          if (!Number.isFinite(typed)) {
            return;
          }
          const clamped = Math.min(max, Math.max(min, settle(typed)));
          if (clamped !== value) {
            onCommit(clamped);
          }
        }}
      />
      {/* Present even without a unit so every field's right edge lines up. */}
      <span aria-hidden={unit ? undefined : true}>{unit}</span>
    </div>
  );
}

/** A full-width message inside a card: a state the user should know about. */
export function Notice({
  tone = 'warning',
  role = 'status',
  action,
  children
}: {
  tone?: 'warning' | 'success' | 'info';
  role?: 'status' | 'alert';
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`settings-notice ${tone}`} role={role}>
      <span>{children}</span>
      {action}
    </div>
  );
}
