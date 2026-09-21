import { useRef, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import type { BodyId, ParameterNode } from '@openzcad/shared';
import { formatNumber } from '../lib/model';

/**
 * The parameter table rows, shared between the Build sidebar and the Tweak
 * panel. They live outside Sidebar.tsx so Tweak mode — which renders no model
 * browser at all — does not have to import one to edit a dimension.
 */

interface ToggleBody {
  bodyId: BodyId;
  name: string;
}
interface ToggleBindingProps {
  bodies?: ToggleBody[];
  onConfigureToggle?: (name: string, bodyIds: BodyId[]) => void;
}
interface ParameterRowProps extends ToggleBindingProps {
  parameter: ParameterNode;
  value: number | undefined;
  onSet(name: string, expression: string): void | Promise<string | null>;
  onViewDetails?(): void;
  minimum?: number;
  onPreview?(name: string, expression: string | null): void;
  /** Absent hides the delete affordance: Tweak adjusts, it never removes. */
  onDelete?: (name: string) => void;
  /**
   * Absent hides the curation toggle, which belongs to Build mode — the
   * workspace that decides what a share link offers, rather than the one
   * that turns what it was given.
   */
  onExpose?: (name: string, exposed: boolean) => void;
  /**
   * Whether this row is currently offered in Tweak. Distinct from
   * `parameter.exposed`: an uncurated document offers everything, so a row
   * can be shown there without carrying the flag.
   */
  exposedInTweak?: boolean;
  /**
   * Edits the gloss shown beside this parameter in Tweak. Offered only for a
   * deliberately exposed parameter: an uncurated document exposes everything,
   * and a description field under all twenty rows would bury the table it is
   * meant to explain.
   */
  onDescribe?: (name: string, description: string) => void;
}

export function ParameterRow({
  parameter,
  value,
  onSet,
  onViewDetails,
  onPreview,
  minimum,
  onDelete,
  onExpose,
  exposedInTweak,
  onDescribe,
  bodies = [],
  onConfigureToggle
}: ParameterRowProps) {
  const [expression, setExpression] = useState(parameter.expression);
  const [editing, setEditing] = useState(false);
  const [syncedExpression, setSyncedExpression] = useState(
    parameter.expression
  );
  const changedByUser = useRef(false);
  const latestParameter = useRef(parameter);
  latestParameter.current = parameter;
  const submission = useRef(0);
  const [error, setError] = useState<{ detailsAvailable: boolean } | null>(
    null
  );
  const [pending, setPending] = useState(false);

  // Undo/redo, document hydration and collaborator edits all replace the
  // canonical expression underneath us. Adopt it, but never yank the field out
  // from under someone who is actively typing in it.
  if (parameter.expression !== syncedExpression) {
    setSyncedExpression(parameter.expression);
    if (!editing) {
      setExpression(parameter.expression);
      changedByUser.current = false;
    }
  }

  async function commit() {
    if (!changedByUser.current) {
      setExpression(parameter.expression);
      onPreview?.(parameter.name, null);
      return;
    }
    const trimmed = expression.trim();
    if (!trimmed || trimmed === parameter.expression) {
      changedByUser.current = false;
      setExpression(parameter.expression);
      onPreview?.(parameter.name, null);
      return;
    }
    changedByUser.current = false;
    const token = ++submission.current;
    setError(null);
    setPending(true);
    try {
      const refusal = await onSet(parameter.name, trimmed);
      if (token !== submission.current) return;
      if (refusal) {
        setError({ detailsAvailable: true });
        setExpression(latestParameter.current.expression);
      }
    } catch {
      if (token !== submission.current) return;
      setError({ detailsAvailable: false });
      setExpression(latestParameter.current.expression);
    } finally {
      if (token === submission.current) setPending(false);
    }
  }

  const describable = onDescribe && parameter.exposed === true;
  const formattedValue = value === undefined ? 'err' : formatNumber(value);
  const showValue =
    value === undefined || formattedValue !== parameter.expression.trim();
  return (
    <div className={describable ? 'param-entry' : undefined}>
      <div
        className="param-row"
        title={`${parameter.name} = ${parameter.expression}`}
      >
        <span className="param-name mono">{parameter.name}</span>
        {parameter.toggle ? (
          <button
            type="button"
            role="switch"
            className="param-toggle"
            aria-label={`Toggle ${parameter.name}`}
            aria-checked={value === 1}
            onClick={() => {
              void onSet(parameter.name, value === 1 ? '0' : '1');
            }}
          >
            <span aria-hidden="true" />
            {value === 1 ? 'On' : 'Off'}
          </button>
        ) : (
          <input
            className="mono"
            value={expression}
            spellCheck={false}
            aria-label={`Expression for ${parameter.name}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={
              error || pending || minimum !== undefined
                ? `parameter-feedback-${parameter.parameterId}`
                : undefined
            }
            onChange={(event) => {
              changedByUser.current = true;
              ++submission.current;
              setError(null);
              setPending(false);
              setExpression(event.target.value);
              onPreview?.(parameter.name, event.target.value);
            }}
            onFocus={() => {
              changedByUser.current = false;
              setEditing(true);
            }}
            onBlur={() => {
              setEditing(false);
              void commit();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                ++submission.current;
                setPending(false);
                setError(null);
                onPreview?.(parameter.name, null);
                changedByUser.current = false;
                setExpression(parameter.expression);
              }
            }}
          />
        )}
        {showValue && !parameter.toggle && (
          <span
            className={`param-value mono ${value === undefined ? 'error' : ''}`}
          >
            {formattedValue}
          </span>
        )}
        {onExpose && (
          <button
            type="button"
            className={`param-expose${exposedInTweak ? ' on' : ''}`}
            aria-pressed={exposedInTweak ?? false}
            title={
              exposedInTweak
                ? `${parameter.name} is offered in Tweak mode and share links`
                : `${parameter.name} is hidden from Tweak mode and share links`
            }
            aria-label={`${exposedInTweak ? 'Hide' : 'Show'} ${parameter.name} in Tweak mode`}
            onClick={() => onExpose(parameter.name, !exposedInTweak)}
          >
            {exposedInTweak ? (
              <Eye size={12} aria-hidden="true" />
            ) : (
              <EyeOff size={12} aria-hidden="true" />
            )}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="row-delete"
            title={`Delete parameter ${parameter.name}`}
            aria-label={`Delete parameter ${parameter.name}`}
            onClick={() => onDelete(parameter.name)}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {(error || pending || minimum !== undefined) && (
        <p
          id={`parameter-feedback-${parameter.parameterId}`}
          className={`parameter-feedback${error ? ' error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error ? (
            <>
              <span>No change applied.</span>
              {error.detailsAvailable && onViewDetails ? (
                <button
                  type="button"
                  className="activity-log-link"
                  onClick={onViewDetails}
                >
                  View details
                </button>
              ) : null}
            </>
          ) : pending ? (
            'Checking geometry…'
          ) : (
            `Minimum ${minimum}`
          )}
        </p>
      )}
      {parameter.toggle && onConfigureToggle && (
        <details className="param-bindings">
          <summary>Bodies ({parameter.toggle.bodyIds.length})</summary>
          <ToggleBodyChoices
            bodies={bodies}
            selected={parameter.toggle.bodyIds}
            onChange={(bodyIds) => onConfigureToggle(parameter.name, bodyIds)}
          />
        </details>
      )}
      {describable && (
        <ParameterDescriptionField
          parameter={parameter}
          onDescribe={onDescribe}
        />
      )}
    </div>
  );
}

/**
 * The description under an exposed parameter. Its own component so the
 * draft state resets cleanly when curation is toggled off and on, and so it
 * follows the same commit-on-blur, revert-on-Escape contract as the
 * expression field above it.
 */
function ParameterDescriptionField({
  parameter,
  onDescribe
}: {
  parameter: ParameterNode;
  onDescribe: (name: string, description: string) => void;
}) {
  const canonical = parameter.description ?? '';
  const [draft, setDraft] = useState(canonical);
  const [synced, setSynced] = useState(canonical);
  const [editing, setEditing] = useState(false);

  if (canonical !== synced) {
    setSynced(canonical);
    if (!editing) {
      setDraft(canonical);
    }
  }

  function commit() {
    if (draft.trim() !== canonical) {
      onDescribe(parameter.name, draft);
    }
  }

  return (
    <input
      className="param-description"
      value={draft}
      placeholder="What this controls (shown in Tweak)"
      spellCheck
      maxLength={140}
      aria-label={`Description for ${parameter.name}`}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setDraft(canonical);
        }
      }}
    />
  );
}

function ToggleBodyChoices({
  bodies,
  selected,
  onChange
}: {
  bodies: ToggleBody[];
  selected: BodyId[];
  onChange(bodyIds: BodyId[]): void;
}) {
  return (
    <fieldset className="param-body-choices">
      <legend>Show these bodies when on</legend>
      {bodies.map((body) => (
        <label key={body.bodyId}>
          <input
            type="checkbox"
            checked={selected.includes(body.bodyId)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, body.bodyId]
                  : selected.filter((id) => id !== body.bodyId)
              )
            }
          />
          <span>{body.name}</span>
        </label>
      ))}
      <p>
        Off hides these bodies and leaves them out of exports. It does not undo
        unions or cuts.
      </p>
    </fieldset>
  );
}

export function AddParameterRow({
  onSet,
  onConfigureToggle,
  bodies = []
}: ToggleBindingProps & {
  onSet(name: string, expression: string): void | Promise<string | null>;
}) {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('');
  const [type, setType] = useState('number');
  const [bodyIds, setBodyIds] = useState<BodyId[]>([]);

  function submit() {
    if (!name.trim()) return;
    if (type === 'toggle' && onConfigureToggle) {
      onConfigureToggle(name.trim(), bodyIds);
    } else if (expression.trim()) {
      void onSet(name.trim(), expression.trim());
    } else return;
    setName('');
    setExpression('');
    setBodyIds([]);
  }

  return (
    <form
      className="param-create"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {onConfigureToggle && (
        <select
          aria-label="New parameter type"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="number">Number / expression</option>
          <option value="toggle">On/off toggle</option>
        </select>
      )}
      <div className="param-add">
        <input
          className="mono"
          placeholder={type === 'toggle' ? 'show_text' : 'name'}
          value={name}
          spellCheck={false}
          aria-label="New parameter name"
          onChange={(event) => setName(event.target.value)}
        />
        {type === 'toggle' ? (
          <span className="param-value">On</span>
        ) : (
          <input
            className="mono"
            placeholder="expression"
            value={expression}
            spellCheck={false}
            aria-label="New parameter expression"
            onChange={(event) => setExpression(event.target.value)}
          />
        )}
        <button
          type="submit"
          className="icon-button"
          title="Add parameter"
          aria-label="Add parameter"
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>
      {type === 'toggle' && (
        <ToggleBodyChoices
          bodies={bodies}
          selected={bodyIds}
          onChange={setBodyIds}
        />
      )}
    </form>
  );
}
