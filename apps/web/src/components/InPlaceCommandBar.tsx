import { Check, MoreHorizontal, SlidersHorizontal, X } from 'lucide-react';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react';
import { ownedTopologyName } from '../lib/topologyLabels';
import { modelingRefusalSummary } from '../lib/modelingRefusal';
import type { InPlacePanelSectionView } from '../lib/inPlace/panel';
import { spokenValueName } from '../lib/inPlace/chipNames';

/**
 * The only chrome an in-place command has: its name, the one-line step it
 * is waiting on, and Cancel / Done. It takes the guidance row above the
 * command bar, so the next step is read in the same place every hint is.
 *
 * The bar itself has no field. Inputs are picked in the model and numbers
 * live on handle chips; behind `options` sits the command's parameter
 * sheet: every choice, and every number typed in place (each also on its
 * chip while its handle stands), grouped and shown only where it applies.
 */
export interface InPlaceOption {
  id: string;
  label: string;
  value: string;
  choices: readonly { value: string; label: string; note?: string }[];
}

/** An exact number too rare for a handle (a primitive's position). */
export interface InPlaceOptionValue {
  id: string;
  label: string;
  /**
   * As shown: the typed expression, or the number (with its unit, unless
   * `suffix` carries it beside an editable field).
   */
  text: string;
  /** The unit shown after an editable field ("mm", "°", "/in"). */
  suffix?: string;
  /** The value as a number, which arrow keys and a scrub step from. */
  value?: number;
  /** One arrow-key or scrub step. */
  step?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  /** What the value means, as its row's tooltip. */
  note?: string;
}

/**
 * A choice row this long or longer is a menu rather than buttons (a gear's
 * six types); an Extrude's five operations stay one press each.
 */
const MENU_CHOICES = 6;
/** Pixels of scrub per step. */
const SCRUB_PX = 4;

export interface InPlaceCommandBarProps {
  title: string;
  hint: string;
  /** False until every required slot is filled and the preview is valid. */
  canFinish: boolean;
  /**
   * Nothing but Cancel takes input (a Done being validated): what the bar
   * shows must stay what is being committed.
   */
  locked?: boolean;
  /** Shown instead of the hint while a refusal stands, in the warning tone. */
  refusal?: string | null;
  /**
   * Rarely used choices (a hole's style, a draft's pull direction), behind
   * a disclosure: each a short row of mutually exclusive buttons.
   */
  options?: readonly InPlaceOption[];
  onOption?(optionId: string, value: string): void;
  /** Opens exact numeric entry on the current draft before committing. */
  onPreciseValues?(): void;
  /**
   * One-off actions beside the choices (a fillet's Select all edges, a
   * chamfer's Swap the two faces), under the same disclosure.
   */
  actions?: readonly { id: string; label: string }[];
  onAction?(actionId: string): void;
  /**
   * The picks a command holds, by name, in pick order (a fillet's edges),
   * each with a remove button, as the card's list had them. The list keeps
   * `minimum` picks: their buttons are off.
   */
  picks?: {
    label: string;
    minimum: number;
    items: readonly { id: string; name: string; owner?: string }[];
  } | null;
  onRemovePick?(id: string): void;
  /** Exact numbers behind the same disclosure, each opening the keypad. */
  values?: readonly InPlaceOptionValue[];
  /** A value's button was pressed, at this client point (for the keypad). */
  onValue?(valueId: string, at: { x: number; y: number }): void;
  /**
   * Values are typed in place rather than on the keypad: the field's text
   * (a number or an expression) is offered here, and false refuses it.
   */
  onValueCommit?(valueId: string, text: string): boolean;
  /** A value scrubbed on its label, before the release commits it. */
  onValuePreview?(valueId: string, value: number): void;
  /**
   * How the rows are ordered and grouped (a gear's tooth form folded
   * away); without it the options come first, then the values.
   */
  sections?: readonly InPlacePanelSectionView[];
  /** What the choices come to, read-only over the rows. */
  summary?: string | null;
  onDone(): void;
  onCancel(): void;
}

export function InPlaceCommandBar({
  title,
  hint,
  canFinish,
  locked = false,
  refusal = null,
  options = [],
  onOption,
  onPreciseValues,
  actions = [],
  onAction,
  picks = null,
  onRemovePick,
  values = [],
  onValue,
  onValueCommit,
  onValuePreview,
  sections,
  summary = null,
  onDone,
  onCancel
}: InPlaceCommandBarProps) {
  const refusalSummary = refusal ? modelingRefusalSummary(refusal) : null;
  const shown = refusalSummary ?? refusal;
  const hintRef = useRef<HTMLSpanElement>(null);
  const hintId = useId();
  // A refusal wraps to three lines; one longer than that offers the rest
  // rather than leaving its recovery to a tooltip (F014).
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    setExpanded(false);
    const element = hintRef.current;
    if (!element || !shown) {
      setClamped(false);
      return;
    }
    const measure = () =>
      setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [shown]);
  return (
    <div
      className={`in-place-command${refusal ? ' refused' : ''}`}
      role="group"
      aria-label={`${title} command`}
    >
      <span className="in-place-command-title">{title}</span>
      <span
        ref={hintRef}
        id={hintId}
        className={`in-place-command-hint${expanded ? ' is-expanded' : ''}`}
        role="status"
        aria-live="polite"
        title={shown ?? undefined}
      >
        {shown ?? hint}
      </span>
      {shown && (clamped || expanded) ? (
        <button
          type="button"
          className="in-place-command-more"
          aria-expanded={expanded}
          aria-controls={hintId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
      {refusalSummary && (
        <details className="in-place-command-options">
          <summary>Technical details</summary>
          <div className="in-place-command-options-panel">
            <p>{refusalSummary}</p>
            <p>{refusal}</p>
          </div>
        </details>
      )}
      {onPreciseValues && (
        <button
          type="button"
          className="in-place-command-cancel"
          onClick={onPreciseValues}
          disabled={locked}
        >
          Precise values…
        </button>
      )}
      {options.length > 0 ||
      values.length > 0 ||
      actions.length > 0 ||
      picks ? (
        <details className="in-place-command-options">
          <summary aria-label={`${title} options`} title="Options">
            {options.length > 0 || values.length > 0 ? (
              <SlidersHorizontal size={14} aria-hidden="true" />
            ) : (
              <MoreHorizontal size={14} aria-hidden="true" />
            )}
          </summary>
          <div className="in-place-command-options-panel in-place-params">
            {picks && picks.items.length > 0 ? (
              <ol className="edge-pick-list" aria-label={picks.label}>
                {picks.items.map((item, index) => {
                  const fullName = item.owner
                    ? ownedTopologyName(item.owner, item.name)
                    : item.name;
                  return (
                    <li key={item.id} className="edge-pick-row">
                      <span className="pick-order mono">{index + 1}</span>
                      <span className="edge-pick-name" title={fullName}>
                        {item.owner ? (
                          <span className="edge-pick-owner">
                            {ownedTopologyName(item.owner, '')}
                          </span>
                        ) : null}
                        <span className="edge-pick-entity">{item.name}</span>
                      </span>
                      <button
                        type="button"
                        className="edge-pick-remove"
                        aria-label={`Remove ${index + 1} ${fullName}`}
                        title={
                          picks.items.length <= picks.minimum
                            ? `${title} needs at least ${picks.minimum}`
                            : 'Remove'
                        }
                        disabled={locked || picks.items.length <= picks.minimum}
                        onClick={() => onRemovePick?.(item.id)}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {summary ? (
              <p className="in-place-params-summary">{summary}</p>
            ) : null}
            {(
              sections ?? [
                {
                  rows: [
                    ...options.map((option) => ({
                      kind: 'option' as const,
                      id: option.id
                    })),
                    ...values.map((value) => ({
                      kind: 'value' as const,
                      id: value.id
                    }))
                  ]
                }
              ]
            ).map((section, index) => (
              <PanelSection
                key={section.label ?? `section-${index}`}
                label={section.label}
                collapsed={section.collapsed ?? false}
              >
                {section.rows.map((row) => {
                  if (row.kind === 'option') {
                    const option = options.find(
                      (candidate) => candidate.id === row.id
                    );
                    return option ? (
                      <OptionRow
                        key={option.id}
                        option={option}
                        locked={locked}
                        onOption={onOption}
                      />
                    ) : null;
                  }
                  const ids = row.kind === 'vector' ? row.ids : [row.id];
                  const fields = ids
                    .map((id) => values.find((value) => value.id === id))
                    .filter(
                      (value): value is InPlaceOptionValue =>
                        value !== undefined
                    );
                  if (fields.length === 0) return null;
                  if (!onValueCommit) {
                    return fields.map((value) => (
                      <KeypadValueRow
                        key={value.id}
                        value={value}
                        locked={locked}
                        onValue={onValue}
                      />
                    ));
                  }
                  return (
                    <ValueRow
                      key={ids.join(':')}
                      label={
                        row.kind === 'vector' ? row.label : fields[0]!.label
                      }
                      axes={row.kind === 'vector' ? row.axes : null}
                      fields={fields}
                      locked={locked}
                      onCommit={onValueCommit}
                      onPreview={onValuePreview}
                    />
                  );
                })}
              </PanelSection>
            ))}
            {actions.length > 0 ? (
              <div className="in-place-option in-place-params-actions">
                {actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="in-place-option-choice"
                    disabled={locked}
                    onClick={() => onAction?.(action.id)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      <button
        type="button"
        className="in-place-command-cancel"
        onClick={onCancel}
        aria-keyshortcuts="Escape"
      >
        <X size={14} aria-hidden="true" />
        Cancel
        <kbd aria-hidden="true">Esc</kbd>
      </button>
      <button
        type="button"
        className="in-place-command-done"
        onClick={onDone}
        disabled={locked || !canFinish}
        aria-keyshortcuts="Enter"
      >
        <Check size={14} aria-hidden="true" />
        Done
        <kbd aria-hidden="true">Enter</kbd>
      </button>
    </div>
  );
}

/** A titled group of rows; a collapsed one folds shut behind its title. */
function PanelSection({
  label,
  collapsed,
  children
}: {
  label: string | undefined;
  collapsed: boolean;
  children: ReactNode;
}) {
  // A button, not a nested <details>: the bar's own Options summary stays
  // the only summary under it.
  const [open, setOpen] = useState(!collapsed);
  const gridId = useId();
  if (collapsed && label) {
    return (
      <section
        className={`in-place-params-section is-foldable${open ? ' is-open' : ''}`}
        aria-label={label}
      >
        <button
          type="button"
          className="in-place-params-heading"
          aria-expanded={open}
          aria-controls={gridId}
          onClick={() => setOpen((shown) => !shown)}
        >
          {label}
        </button>
        <div className="in-place-params-grid" id={gridId} hidden={!open}>
          {children}
        </div>
      </section>
    );
  }
  return (
    <section
      className="in-place-params-section"
      aria-label={label ?? undefined}
    >
      {label ? <h3 className="in-place-params-heading">{label}</h3> : null}
      <div className="in-place-params-grid">{children}</div>
    </section>
  );
}

/**
 * Mutually exclusive choices: a segmented row of buttons, or a menu once
 * there are too many to sit side by side (a gear's six types).
 */
function OptionRow({
  option,
  locked,
  onOption
}: {
  option: InPlaceOption;
  locked: boolean;
  onOption: ((optionId: string, value: string) => void) | undefined;
}) {
  const labelId = useId();
  const note = option.choices.find(
    (choice) => choice.value === option.value
  )?.note;
  const menu = option.choices.length >= MENU_CHOICES;
  return (
    <div className="in-place-option in-place-param-row">
      <span className="in-place-option-label" id={labelId}>
        {option.label}
      </span>
      {menu ? (
        <select
          className="in-place-param-select"
          aria-labelledby={labelId}
          value={option.value}
          disabled={locked}
          onChange={(event) => onOption?.(option.id, event.target.value)}
        >
          {option.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : (
        <div
          className="in-place-param-segments"
          role="radiogroup"
          aria-label={option.label}
        >
          {option.choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={choice.value === option.value}
              className="in-place-option-choice"
              disabled={locked}
              onClick={() => onOption?.(option.id, choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
      {note ? <p className="in-place-option-note">{note}</p> : null}
    </div>
  );
}

/** A value that opens the keypad (a command that types nothing in place). */
function KeypadValueRow({
  value,
  locked,
  onValue
}: {
  value: InPlaceOptionValue;
  locked: boolean;
  onValue:
    ((valueId: string, at: { x: number; y: number }) => void) | undefined;
}) {
  return (
    <div className="in-place-option in-place-param-row">
      <span className="in-place-option-label" aria-hidden="true">
        {value.label}
      </span>
      <button
        type="button"
        className="in-place-option-choice in-place-option-value"
        disabled={locked}
        // The visible label may be a glyph ("⌀", "R"); the name is in words.
        aria-label={spokenValueName(value.label)}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          // Exact entry takes over from Options. Leaving its flyout
          // open covers the keypad in the command lane's context.
          event.currentTarget.closest('details')?.removeAttribute('open');
          onValue?.(value.id, { x: box.left, y: box.bottom });
        }}
      >
        {value.text}
      </button>
    </div>
  );
}

/** A value within its limits, whole where it must be. */
function bounded(field: InPlaceOptionValue, value: number): number {
  let next = field.integer ? Math.round(value) : value;
  if (field.min !== undefined) next = Math.max(field.min, next);
  if (field.max !== undefined) next = Math.min(field.max, next);
  // Steps of 0.1 drift (0.30000000000000004): six places is plenty.
  return Math.round(next * 1e6) / 1e6;
}

/**
 * One named number, or a point's coordinates side by side, typed in place.
 * Its name scrubs: dragged sideways it steps the value (Shift ten at a
 * time), previewing as it goes and committing on release.
 */
function ValueRow({
  label,
  axes,
  fields,
  locked,
  onCommit,
  onPreview
}: {
  label: string;
  axes: readonly string[] | null;
  fields: readonly InPlaceOptionValue[];
  locked: boolean;
  onCommit(valueId: string, text: string): boolean;
  onPreview: ((valueId: string, value: number) => void) | undefined;
}) {
  const firstId = useId();
  const scrub = useRef<{
    pointer: number;
    x: number;
    from: number;
    last: number;
    moved: boolean;
  } | null>(null);
  const scrubbedLast = useRef(false);
  // A point's row scrubs nothing: its name is not one value's.
  const scrubbed = axes ? null : fields[0]!;
  const note = fields.length === 1 ? fields[0]!.note : undefined;
  return (
    <div
      className={`in-place-param-row in-place-param-value${axes ? ' is-vector' : ''}`}
    >
      <label
        className={`in-place-option-label${scrubbed && !locked ? ' is-scrubbable' : ''}`}
        htmlFor={firstId}
        title={
          note ?? (scrubbed && !locked ? 'Drag sideways to change' : undefined)
        }
        onPointerDown={(event: PointerEvent<HTMLLabelElement>) => {
          if (!scrubbed || locked || event.button !== 0) return;
          scrub.current = {
            pointer: event.pointerId,
            x: event.clientX,
            from: scrubbed.value ?? 0,
            last: scrubbed.value ?? 0,
            moved: false
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const state = scrub.current;
          if (!state || !scrubbed || event.pointerId !== state.pointer) return;
          const steps = Math.trunc((event.clientX - state.x) / SCRUB_PX);
          if (steps === 0 && !state.moved) return;
          state.moved = true;
          const step = (scrubbed.step ?? 1) * (event.shiftKey ? 10 : 1);
          const next = bounded(scrubbed, state.from + steps * step);
          if (next !== state.last) {
            state.last = next;
            onPreview?.(scrubbed.id, next);
          }
        }}
        onPointerUp={(event) => {
          const state = scrub.current;
          scrub.current = null;
          if (!state || !scrubbed || event.pointerId !== state.pointer) return;
          if (state.moved) {
            scrubbedLast.current = true;
            onCommit(scrubbed.id, String(state.last));
          }
        }}
        onPointerCancel={() => {
          const state = scrub.current;
          scrub.current = null;
          if (state?.moved && scrubbed) {
            onCommit(scrubbed.id, String(state.from));
          }
        }}
        onClick={(event) => {
          // A scrub's release is not a click into the field.
          if (scrubbedLast.current) {
            scrubbedLast.current = false;
            event.preventDefault();
          }
        }}
      >
        {label}
      </label>
      <div className="in-place-param-fields">
        {fields.map((field, index) => (
          <ValueField
            key={field.id}
            id={index === 0 ? firstId : undefined}
            field={field}
            axis={axes?.[index] ?? null}
            label={axes ? `${label} ${axes[index]}` : label}
            locked={locked}
            onCommit={onCommit}
          />
        ))}
      </div>
    </div>
  );
}

function ValueField({
  id,
  field,
  axis,
  label,
  locked,
  onCommit
}: {
  id: string | undefined;
  field: InPlaceOptionValue;
  axis: string | null;
  label: string;
  locked: boolean;
  onCommit(valueId: string, text: string): boolean;
}) {
  // The text being typed, while the field has focus; else what is held.
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  // Escape's blur drops the draft rather than committing it.
  const dropOnBlur = useRef(false);
  const shown = draft ?? field.text;
  const commit = (text: string): boolean => {
    if (text.trim() === field.text.trim()) {
      setRefused(false);
      return true;
    }
    const accepted = onCommit(field.id, text);
    setRefused(!accepted);
    return accepted;
  };
  const step = (by: number) => {
    const next = bounded(field, (field.value ?? 0) + by);
    if (onCommit(field.id, String(next))) {
      setDraft(null);
      setRefused(false);
    }
  };
  return (
    <span
      className={`in-place-param-field${refused ? ' is-refused' : ''}`}
      title={refused ? `${label} cannot take ${shown}` : undefined}
    >
      {axis ? (
        <span className="in-place-param-axis" aria-hidden="true">
          {axis}
        </span>
      ) : null}
      <input
        id={id}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label={spokenValueName(label)}
        aria-invalid={refused || undefined}
        value={shown}
        disabled={locked}
        onFocus={(event) => {
          setDraft(field.text);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setRefused(false);
        }}
        onBlur={() => {
          // A refused entry is dropped on leaving, not kept half-applied.
          if (draft !== null && !dropOnBlur.current) commit(draft);
          dropOnBlur.current = false;
          setDraft(null);
          setRefused(false);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (commit(shown)) {
              setDraft(null);
              event.currentTarget.select();
            }
          } else if (event.key === 'Escape') {
            // Escape puts the field back; the next one cancels the command.
            event.preventDefault();
            event.stopPropagation();
            dropOnBlur.current = true;
            setDraft(null);
            setRefused(false);
            event.currentTarget.blur();
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            const sign = event.key === 'ArrowUp' ? 1 : -1;
            const scale = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
            step(sign * (field.step ?? 1) * scale);
          }
        }}
      />
      {field.suffix ? (
        <span className="in-place-param-suffix" aria-hidden="true">
          {field.suffix}
        </span>
      ) : null}
    </span>
  );
}
