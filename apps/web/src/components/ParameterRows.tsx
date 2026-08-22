import { useRef, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import type { ParameterNode } from '@openzcad/shared';
import { formatNumber } from '../lib/model';

/**
 * The parameter table rows, shared between the Build sidebar and the Tweak
 * panel. They live outside Sidebar.tsx so Tweak mode — which renders no model
 * browser at all — does not have to import one to edit a dimension.
 */

interface ParameterRowProps {
  parameter: ParameterNode;
  value: number | undefined;
  onSet(name: string, expression: string): void;
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
  onDelete,
  onExpose,
  exposedInTweak,
  onDescribe
}: ParameterRowProps) {
  const [expression, setExpression] = useState(parameter.expression);
  const [editing, setEditing] = useState(false);
  const [syncedExpression, setSyncedExpression] = useState(
    parameter.expression
  );
  const changedByUser = useRef(false);

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

  function commit() {
    if (!changedByUser.current) {
      setExpression(parameter.expression);
      return;
    }
    changedByUser.current = false;
    const trimmed = expression.trim();
    if (trimmed.length > 0 && trimmed !== parameter.expression) {
      onSet(parameter.name, trimmed);
    } else {
      setExpression(parameter.expression);
    }
  }

  const describable = onDescribe && parameter.exposed === true;
  return (
    <div className={describable ? 'param-entry' : undefined}>
    <div
      className="param-row"
      title={`${parameter.name} = ${parameter.expression}`}
    >
      <span className="param-name mono">{parameter.name}</span>
      <input
        className="mono"
        value={expression}
        spellCheck={false}
        aria-label={`Expression for ${parameter.name}`}
        onChange={(event) => {
          changedByUser.current = true;
          setExpression(event.target.value);
        }}
        onFocus={() => {
          changedByUser.current = false;
          setEditing(true);
        }}
        onBlur={() => {
          setEditing(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            changedByUser.current = false;
            setExpression(parameter.expression);
          }
        }}
      />
      <span
        className={`param-value mono ${value === undefined ? 'error' : ''}`}
      >
        {value === undefined ? 'err' : formatNumber(value)}
      </span>
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

export function AddParameterRow({
  onSet
}: {
  onSet(name: string, expression: string): void;
}) {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('');

  function submit() {
    if (name.trim().length > 0 && expression.trim().length > 0) {
      onSet(name.trim(), expression.trim());
      setName('');
      setExpression('');
    }
  }

  return (
    <form
      className="param-add"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        className="mono"
        placeholder="name"
        value={name}
        spellCheck={false}
        aria-label="New parameter name"
        onChange={(event) => setName(event.target.value)}
      />
      <input
        className="mono"
        placeholder="expression"
        value={expression}
        spellCheck={false}
        aria-label="New parameter expression"
        onChange={(event) => setExpression(event.target.value)}
      />
      <button
        type="submit"
        className="icon-button"
        title="Add parameter"
        aria-label="Add parameter"
      >
        <Plus size={13} aria-hidden="true" />
      </button>
    </form>
  );
}
