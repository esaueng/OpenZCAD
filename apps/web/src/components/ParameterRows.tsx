import { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
}

export function ParameterRow({
  parameter,
  value,
  onSet,
  onDelete
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

  return (
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
