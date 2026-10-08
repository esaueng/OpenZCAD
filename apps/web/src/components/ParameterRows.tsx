import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
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
  /** Absent keeps the parameter name read-only, as it is in Tweak mode. */
  onRename?: (
    name: string,
    newName: string
  ) => string | null | void | Promise<string | null | void>;
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
  onRename,
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
  const [error, setError] = useState<{
    message: string;
    detailsAvailable: boolean;
  } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(parameter.name);
  const [pending, setPending] = useState(false);
  const nameEditorRef = useRef<HTMLInputElement | null>(null);
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);
  // Set when Enter or Escape closes the rename editor: the keyboard is here,
  // so focus returns to the name rather than falling to <body>.
  const refocusName = useRef(false);
  useEffect(() => {
    if (!renaming && refocusName.current) {
      refocusName.current = false;
      renameButtonRef.current?.focus();
    }
  }, [renaming]);

  async function commitRename() {
    const newName = nameDraft.trim();
    if (!newName || newName === parameter.name) {
      setNameDraft(parameter.name);
      setRenameError(null);
      setRenaming(false);
      return;
    }
    try {
      const refusal = await onRename?.(parameter.name, newName);
      if (refusal) {
        setRenameError(`${refusal} No change applied.`);
        keepRenaming();
        return;
      }
      setRenameError(null);
      setRenaming(false);
    } catch (cause) {
      setRenameError(
        cause instanceof Error
          ? cause.message
          : 'The parameter could not be renamed.'
      );
      keepRenaming();
    }
  }

  /** A refused rename from Enter puts the caret back in the name to fix. */
  function keepRenaming() {
    if (refocusName.current) {
      refocusName.current = false;
      nameEditorRef.current?.focus();
    }
  }

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
        setError({ message: refusal, detailsAvailable: true });
        setExpression(latestParameter.current.expression);
      }
    } catch {
      if (token !== submission.current) return;
      setError({
        message: 'The parameter could not be updated.',
        detailsAvailable: false
      });
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
        {renaming ? (
          <input
            ref={nameEditorRef}
            className="param-name-editor mono"
            value={nameDraft}
            spellCheck={false}
            autoFocus
            aria-label={`Rename parameter ${parameter.name}`}
            aria-invalid={renameError ? true : undefined}
            aria-describedby={
              renameError
                ? `parameter-feedback-${parameter.parameterId}`
                : undefined
            }
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setNameDraft(event.target.value);
              setRenameError(null);
            }}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                refocusName.current = true;
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                refocusName.current = true;
                setNameDraft(parameter.name);
                setRenameError(null);
                setRenaming(false);
              }
            }}
          />
        ) : onRename ? (
          <button
            ref={renameButtonRef}
            type="button"
            className="param-name param-name-button mono"
            title={`Rename parameter ${parameter.name}`}
            aria-label={`Rename parameter ${parameter.name}`}
            onClick={() => {
              setNameDraft(parameter.name);
              setRenameError(null);
              setRenaming(true);
            }}
          >
            <span>{parameter.name}</span>
            <Pencil size={10} aria-hidden="true" />
          </button>
        ) : (
          <span className="param-name mono">{parameter.name}</span>
        )}
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
        {/* Always a cell, empty when it would repeat the expression: the
            row is a grid, and a missing cell moved the buttons after it
            one track to the left. */}
        {!parameter.toggle && (
          <span
            className={`param-value mono ${value === undefined ? 'error' : ''}`}
          >
            {showValue ? formattedValue : ''}
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
            onClick={(event) => {
              const button = event.currentTarget;
              const next = focusAfterDelete(button);
              onDelete(parameter.name);
              // The delete re-renders synchronously; once this row is gone,
              // focus moves on instead of falling to <body>. A refused
              // delete leaves the row, and focus, where they were.
              setTimeout(() => {
                if (!button.isConnected && next?.isConnected) next.focus();
              }, 0);
            }}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {(renameError || error || pending || minimum !== undefined) && (
        <p
          id={`parameter-feedback-${parameter.parameterId}`}
          className={`parameter-feedback${renameError || error ? ' error' : ''}`}
          role={renameError || error ? 'alert' : 'status'}
        >
          {renameError ? (
            renameError
          ) : error ? (
            <>
              <span>{error.message} No change applied.</span>
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
            `Minimum ${formatNumber(minimum ?? Number.NaN)}`
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
 * Where focus goes when a row's delete removes it: the next parameter's name
 * (or expression, where names are read-only), the add row's name field after
 * the last one, or the previous parameter at the end of a list without one.
 */
function focusAfterDelete(deleteButton: HTMLElement): HTMLElement | null {
  const row = deleteButton.closest('.param-row');
  const entry = row?.parentElement;
  if (!entry) return null;
  for (const sibling of [
    entry.nextElementSibling,
    entry.previousElementSibling
  ]) {
    const target = sibling?.querySelector<HTMLElement>(
      '.param-name-button, input'
    );
    if (target) return target;
  }
  return null;
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
      {bodies.length === 0 ? <p>No bodies yet.</p> : null}
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
  bodies = [],
  existingNames = []
}: ToggleBindingProps & {
  onSet(name: string, expression: string): void | Promise<string | null>;
  /**
   * Names already in the table. Setting a parameter is set-by-name, so an
   * add under a taken name silently replaced that parameter — and every
   * feature using it. The add row refuses one instead.
   */
  existingNames?: readonly string[];
}) {
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('');
  const [type, setType] = useState('number');
  const [bodyIds, setBodyIds] = useState<BodyId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const feedbackId = useId();
  // Bumped by every edit, so a refusal or a success that lands after the
  // user has typed something new neither reports on nor clears the new text.
  const edits = useRef(0);

  function edited() {
    edits.current += 1;
    setError(null);
  }

  async function submit() {
    const trimmedName = name.trim();
    const trimmedExpression = expression.trim();
    if (!trimmedName) return;
    const toggle = type === 'toggle' && onConfigureToggle;
    if (!toggle && !trimmedExpression) return;
    if (existingNames.includes(trimmedName)) {
      setError(`${trimmedName} already exists. Change it in its own row.`);
      return;
    }
    const submitted = edits.current;
    if (toggle) {
      toggle(trimmedName, bodyIds);
    } else {
      let refusal: string | null | void;
      try {
        refusal = await onSet(trimmedName, trimmedExpression);
      } catch {
        refusal = 'The parameter could not be added.';
      }
      if (submitted !== edits.current) return;
      // A refused add keeps what was typed, so it can be corrected.
      if (refusal) {
        setError(`${refusal} Not added.`);
        return;
      }
    }
    setName('');
    setExpression('');
    setBodyIds([]);
    setError(null);
  }

  return (
    <form
      className="param-create"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {onConfigureToggle && (
        <select
          aria-label="New parameter type"
          value={type}
          onChange={(event) => {
            edited();
            setType(event.target.value);
          }}
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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? feedbackId : undefined}
          onChange={(event) => {
            edited();
            setName(event.target.value);
          }}
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
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? feedbackId : undefined}
            onChange={(event) => {
              edited();
              setExpression(event.target.value);
            }}
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
      {error ? (
        <p id={feedbackId} className="parameter-feedback error" role="alert">
          {error}
        </p>
      ) : null}
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
